import cron from "node-cron";
import dayjs from "dayjs";
import { db, getOpenVoiceSessions } from "@/db/db.ts";
import { userTable } from "@/db/schema.ts";
import { inArray, sql } from "drizzle-orm";
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

          const boosterIds = getBoosterIds(guild, usersNeedingReset);
          if (boosterIds.length > 0) {
            log.debug("Boosters preserving streak", { opId, count: boosterIds.length });
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

          await updateStreakNicknames(guild, opId, updatedUsers);

          return updatedUsers.length;
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

function getBoosterIds(guild: Guild, usersNeedingReset: string[]): string[] {
  const usersNeedingResetSet = new Set(usersNeedingReset);
  return guild.members.cache
    .filter((member) => member.premiumSince !== null && usersNeedingResetSet.has(member.id))
    .map((member) => member.id);
}

async function updateStreakNicknames(
  guild: Guild,
  opId: string,
  users: { discordId: string; messageStreak: number }[],
) {
  await Promise.all(
    users.map(async (row) => {
      const member = guild.members.cache.get(row.discordId);
      if (!member) return;
      await updateMessageStreakInNickname(member, row.messageStreak, opId);
    }),
  );
}
