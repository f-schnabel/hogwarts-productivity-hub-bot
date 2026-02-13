import cron from "node-cron";
import dayjs from "dayjs";
import { db, getOpenVoiceSessions, type Tx } from "@/db/db.ts";
import { userTable } from "@/db/schema.ts";
import { and, gt, inArray, lt, or, sql } from "drizzle-orm";
import { endVoiceSession, startVoiceSession } from "@/discord/utils/voiceUtils.ts";
import { wrapWithAlerting } from "@/discord/utils/alerting.ts";
import { resetExecutionTimer } from "@/common/monitoring.ts";
import { updateMessageStreakInNickname } from "@/discord/utils/nicknameUtils.ts";
import { MIN_DAILY_MESSAGES_FOR_STREAK } from "@/common/constants.ts";
import { createLogger, OpId } from "@/common/logger.ts";
import type { Guild } from "discord.js";
import { getGuild } from "@/discord/events/clientReady.ts";

const log = createLogger("Reset");

export function start() {
  // Schedule daily reset checks - run every hour to catch all timezones
  cron.schedule(
    "0 * * * *",
    () => {
      void processDailyResets();
    },
    {
      timezone: "UTC",
    },
  );

  log.debug("CentralResetService started");
}

async function processDailyResets() {
  const end = resetExecutionTimer.startTimer();
  const opId = OpId.rst();
  const guild = getGuild();

  log.debug("Daily reset start", { opId });

  const usersReset = await wrapWithAlerting(
    async () => {
      return await db.transaction(async (db) => {
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
          log.debug("No users need reset", { opId });
          return;
        }

        const usersInVoiceSessions = await getOpenVoiceSessions(db, usersNeedingReset);
        log.info("Users identified", {
          opId,
          total: usersNeedingReset.length,
          inVoice: usersInVoiceSessions.map((s) => s.discordId).join(", "),
        });

        try {
          await Promise.all(usersInVoiceSessions.map((session) => endVoiceSession(session, db, opId)));

          const boostersUpdated = await creditBoosters(db, guild, usersNeedingReset);
          if (boostersUpdated > 0) {
            log.debug("Boosters auto-credited", { opId, count: boostersUpdated });
          }

          await updateStreakNicknames(db, guild, opId, usersNeedingReset);

          return await db
            .update(userTable)
            .set({
              dailyPoints: 0,
              dailyVoiceTime: 0,
              lastDailyReset: new Date(),
              messageStreak: sql`CASE WHEN ${userTable.dailyMessages} >= ${MIN_DAILY_MESSAGES_FOR_STREAK} THEN ${userTable.messageStreak} + 1 ELSE 0 END`,
              dailyMessages: 0,
            })
            .where(inArray(userTable.discordId, usersNeedingReset))
            .then((result) => result.rowCount);
        } finally {
          await Promise.all(usersInVoiceSessions.map((session) => startVoiceSession(session, db, opId)));
        }
      });
    },
    "Daily reset processing",
    opId,
  );
  log.info("Daily reset complete", { opId, usersReset, ms: end({ action: "daily" }) });
}

async function creditBoosters(db: Tx, guild: Guild, usersNeedingReset: string[]): Promise<number> {
  const usersNeedingResetSet = new Set(usersNeedingReset);
  const boosters = guild.members.cache
    .filter((member) => member.premiumSince !== null && usersNeedingResetSet.has(member.id))
    .map((member) => member.id);

  if (boosters.length === 0) return 0;

  // Ensure boosters meet the minimum message threshold so they maintain their streak
  await db
    .update(userTable)
    .set({
      dailyMessages: sql`GREATEST(${userTable.dailyMessages}, ${MIN_DAILY_MESSAGES_FOR_STREAK})`,
    })
    .where(inArray(userTable.discordId, boosters));

  return boosters.length;
}

async function updateStreakNicknames(db: Tx, guild: Guild, opId: string, usersNeedingReset: string[]) {
  const users = await db
    .select({
      discordId: userTable.discordId,
      messageStreak: userTable.messageStreak,
      dailyMessages: userTable.dailyMessages,
    })
    .from(userTable)
    .where(
      and(
        inArray(userTable.discordId, usersNeedingReset),
        or(
          // Users gaining streak (met threshold)
          sql`${userTable.dailyMessages} >= ${MIN_DAILY_MESSAGES_FOR_STREAK}`,
          // Users losing streak (didn't meet threshold but had one)
          and(lt(userTable.dailyMessages, MIN_DAILY_MESSAGES_FOR_STREAK), gt(userTable.messageStreak, 0)),
        ),
      ),
    );

  if (users.length === 0) return;

  const gaining = users.filter((u) => u.dailyMessages >= MIN_DAILY_MESSAGES_FOR_STREAK);
  const losing = users.filter((u) => u.dailyMessages < MIN_DAILY_MESSAGES_FOR_STREAK);

  if (losing.length > 0) {
    log.debug("Streaks being reset", {
      opId,
      users: losing.map((u) => u.discordId).join(", "),
    });
  }
  if (gaining.length > 0) {
    log.debug("Streaks being incremented", {
      opId,
      users: gaining.map((u) => u.discordId).join(", "),
    });
  }

  await Promise.all(
    users.map(async (row) => {
      const member = guild.members.cache.get(row.discordId);
      if (!member) return;
      const newStreak = row.dailyMessages >= MIN_DAILY_MESSAGES_FOR_STREAK ? row.messageStreak + 1 : 0;
      await updateMessageStreakInNickname(member, newStreak, opId);
    }),
  );
}
