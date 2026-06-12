import cron from "node-cron";
import dayjs from "dayjs";
import { db, getOpenVoiceSessions } from "@/db/db.ts";
import { submissionTable, userTable } from "@/db/schema.ts";
import { and, asc, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { endVoiceSession, startVoiceSession } from "@/discord/events/voiceStateUpdate/voiceSession.ts";
import { wrapWithAlerting } from "@/discord/utils/alerting.ts";
import { resetExecutionTimer } from "@/common/logging/monitoring.ts";
import { updateMessageStreakInNickname } from "@/discord/core/nicknameStreak.ts";
import { MIN_DAILY_MESSAGES_FOR_STREAK, SUBMISSION_TYPES } from "@/common/constants.ts";
import { createLogger, OpId } from "@/common/logging/logger.ts";
import { runWithOpContext } from "@/common/logging/opContext.ts";
import { userMention, type Guild } from "discord.js";
import { getGuild } from "@/discord/events/clientReady/index.ts";

const log = createLogger("Reset");

export function start() {
  // Schedule daily reset checks - run every hour to catch all timezones
  cron.schedule(
    "0 * * * *",
    () => {
      void runWithOpContext(OpId.rst(), async () => {
        await processDailyResets();
      });
    },
    {
      timezone: "UTC",
    },
  );

  log.debug("CentralResetService started");
}

async function processDailyResets() {
  const end = resetExecutionTimer.startTimer();
  const guild = getGuild();

  log.debug("Daily reset start");

  const result = await wrapWithAlerting(async () => {
    const remindersSent = await processSubmissionReminders(guild);
    const usersReset = await db.transaction(async (db) => {
      const usersNeedingPotentialReset = await db
        .select({
          discordId: userTable.discordId,
          timezone: userTable.timezone,
          lastDailyReset: userTable.lastDailyReset,
        })
        .from(userTable);

      // Get guild members to filter out users who left
      const guildMemberIds = new Set(guild.members.cache.keys());

      // Filter to only include users who are still in guild and past their local midnight
      const usersNeedingReset: string[] = [];
      for (const user of usersNeedingPotentialReset) {
        if (!guildMemberIds.has(user.discordId)) continue;

        const userTime = dayjs().tz(user.timezone);
        const lastReset = dayjs(user.lastDailyReset).tz(user.timezone);

        if (!userTime.isSame(lastReset, "day")) {
          usersNeedingReset.push(user.discordId);
        }
      }

      if (usersNeedingReset.length === 0) {
        log.debug("No users need reset");
        return 0;
      }

      const usersInVoiceSessions = await getOpenVoiceSessions(db, usersNeedingReset);
      log.info("Users identified", {
        total: usersNeedingReset.length,
        inVoice: usersInVoiceSessions.map((s) => s.discordId).join(", "),
      });

      try {
        for (const session of usersInVoiceSessions) {
          await endVoiceSession(session, db);
        }

        const boosterIds = getBoosterIds(guild, usersNeedingReset);
        if (boosterIds.length > 0) {
          log.debug("Boosters preserving streak", { count: boosterIds.length });
        }

        const updatedUsers = await db
          .update(userTable)
          .set({
            dailyPoints: 0,
            dailyVoiceTime: 0,
            lastDailyReset: new Date(),
            // Met threshold → increment, booster (below threshold) → preserve, otherwise → reset
            messageStreak: sql`CASE
                WHEN ${userTable.dailyMessages} >= ${MIN_DAILY_MESSAGES_FOR_STREAK} 
                  THEN ${userTable.messageStreak} + 1
                WHEN ${inArray(userTable.discordId, boosterIds)}
                  THEN ${userTable.messageStreak}
                ELSE 0
                END`,
            dailyMessages: 0,
          })
          .where(inArray(userTable.discordId, usersNeedingReset))
          .returning({ discordId: userTable.discordId, messageStreak: userTable.messageStreak });

        await updateStreakNicknames(guild, updatedUsers);

        return updatedUsers.length;
      } finally {
        for (const session of usersInVoiceSessions) {
          await startVoiceSession(session, db);
        }
      }
    });

    return { usersReset, remindersSent };
  }, "Daily reset processing");
  log.info("Daily reset complete", {
    usersReset: result.usersReset,
    remindersSent: result.remindersSent,
    ms: end({ action: "daily" }),
  });
}

async function processSubmissionReminders(guild: Guild, now: Date = new Date()): Promise<number> {
  const dueReminders = await db
    .select({
      id: submissionTable.id,
      discordId: submissionTable.discordId,
      channelId: submissionTable.channelId,
      messageId: submissionTable.messageId,
      reminderAt: submissionTable.reminderAt,
    })
    .from(submissionTable)
    .where(
      and(
        eq(submissionTable.status, "APPROVED"),
        eq(submissionTable.submissionType, SUBMISSION_TYPES.NEW),
        isNotNull(submissionTable.reminderAt),
        lte(submissionTable.reminderAt, now),
      ),
    )
    .orderBy(asc(submissionTable.reminderAt));

  if (dueReminders.length === 0) return 0;

  log.info("Submission reminders due", { count: dueReminders.length });

  let sent = 0;
  for (const reminder of dueReminders) {
    const delivered = await deliverSubmissionReminder(guild, reminder);
    if (delivered) sent++;
  }

  return sent;
}

async function deliverSubmissionReminder(
  guild: Guild,
  reminder: {
    id: number;
    discordId: string;
    channelId: string | null;
    messageId: string | null;
    reminderAt: Date | null;
  },
): Promise<boolean> {
  if (!reminder.channelId || !reminder.messageId) {
    log.warn("Clearing reminder without message reference", { submissionId: reminder.id });
    await clearSubmissionReminder(reminder.id);
    return false;
  }

  const channel = await guild.client.channels.fetch(reminder.channelId);
  if (!channel?.isTextBased()) {
    log.warn("Clearing reminder for unavailable channel", { submissionId: reminder.id, channelId: reminder.channelId });
    await clearSubmissionReminder(reminder.id);
    return false;
  }

  let message;
  try {
    message = await channel.messages.fetch(reminder.messageId);
  } catch (error) {
    log.error("Clearing reminder for unavailable submission message", {
      submissionId: reminder.id,
      messageId: reminder.messageId,
    }, error);
    await clearSubmissionReminder(reminder.id);
    return false;
  }

  try {
    await message.reply({
      content: `${userMention(reminder.discordId)} Reminder to complete your submitted to-do list.`,
      allowedMentions: { users: [reminder.discordId] },
    });
  } catch (error) {
    log.error("Failed to send submission reminder", { submissionId: reminder.id }, error);
    return false;
  }

  await clearSubmissionReminder(reminder.id);
  return true;
}

async function clearSubmissionReminder(submissionId: number): Promise<void> {
  await db.update(submissionTable).set({ reminderAt: null }).where(eq(submissionTable.id, submissionId));
}

function getBoosterIds(guild: Guild, usersNeedingReset: string[]): string[] {
  const usersNeedingResetSet = new Set(usersNeedingReset);
  return guild.members.cache
    .filter((member) => member.premiumSince !== null && usersNeedingResetSet.has(member.id))
    .map((member) => member.id);
}

async function updateStreakNicknames(guild: Guild, users: { discordId: string; messageStreak: number }[]) {
  await Promise.all(
    users.map(async (row) => {
      const member = guild.members.cache.get(row.discordId);
      if (!member) return;
      await updateMessageStreakInNickname(member, row.messageStreak);
    }),
  );
}
