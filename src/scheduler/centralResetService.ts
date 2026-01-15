import cron from "node-cron";
import dayjs from "dayjs";
import { db, getOpenVoiceSessions, type Tx } from "../db/db.ts";
import { userTable } from "../db/schema.ts";
import { and, eq, inArray, sql } from "drizzle-orm";
import { endVoiceSession, startVoiceSession } from "../utils/voiceUtils.ts";
import { wrapWithAlerting } from "../utils/alerting.ts";
import { resetExecutionTimer } from "../monitoring.ts";
import { updateMessageStreakInNickname } from "../utils/nicknameUtils.ts";
import { createLogger, OpId } from "../utils/logger.ts";
import type { Guild } from "discord.js";
import { getGuild } from "../events/clientReady.ts";

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

          const boostersUpdated = await setBoosterPerk(db, guild, new Set(usersNeedingReset));
          if (boostersUpdated > 0) {
            log.debug("Boosters auto-credited", { opId, count: boostersUpdated });
          }

          await loseMessageStreakInNickname(db, guild, opId, usersNeedingReset);

          return await db
            .update(userTable)
            .set({
              dailyPoints: 0,
              dailyVoiceTime: 0,
              lastDailyReset: new Date(),
              messageStreak: sql`CASE WHEN ${userTable.isMessageStreakUpdatedToday} = false THEN 0 ELSE ${userTable.messageStreak} END`,
              isMessageStreakUpdatedToday: false,
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

async function setBoosterPerk(db: Tx, guild: Guild, usersNeedingReset: Set<string>): Promise<number> {
  const boosters = guild.members.cache
    .filter((member) => member.premiumSince !== null && usersNeedingReset.has(member.id))
    .map((member) => member.id);

  if (boosters.length === 0) return 0;

  await db
    .update(userTable)
    .set({
      isMessageStreakUpdatedToday: true,
    })
    .where(inArray(userTable.discordId, boosters));

  return boosters.length;
}

async function loseMessageStreakInNickname(db: Tx, guild: Guild, opId: string, usersNeedingReset: string[]) {
  const usersLosingStreak = await db
    .select({ discordId: userTable.discordId })
    .from(userTable)
    .where(and(inArray(userTable.discordId, usersNeedingReset), eq(userTable.isMessageStreakUpdatedToday, false)));

  if (usersLosingStreak.length === 0) return;

  log.debug("Streaks being reset", {
    opId,
    usersLosingStreak: usersLosingStreak.map((u) => u.discordId).join(", "),
  });

  await Promise.all(
    usersLosingStreak.map(async (row) => {
      const member = guild.members.cache.get(row.discordId);
      if (!member) return;
      await updateMessageStreakInNickname(member, 0, opId);
    }),
  );
}
