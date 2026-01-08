import cron from "node-cron";
import dayjs from "dayjs";
import { db, fetchOpenVoiceSessions, type Schema } from "../db/db.ts";
import { userTable } from "../db/schema.ts";
import { and, eq, inArray, sql, type ExtractTablesWithRelations } from "drizzle-orm";
import { endVoiceSession, startVoiceSession } from "../utils/voiceUtils.ts";
import { wrapWithAlerting } from "../utils/alerting.ts";
import { resetExecutionTimer } from "../monitoring.ts";
import { client } from "../client.ts";
import { updateMessageStreakInNickname } from "../utils/utils.ts";
import type { PgTransaction } from "drizzle-orm/pg-core";
import type { NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import { createLogger, OpId } from "../utils/logger.ts";

const log = createLogger("Reset");
const scheduledJobs = new Map<string, cron.ScheduledTask>();

export async function start() {
  // Schedule daily reset checks - run every hour to catch all timezones
  const dailyResetJob = cron.schedule(
    "0 * * * *",
    async () => {
      await processDailyResets();
    },
    {
      timezone: "UTC",
    },
  );

  // Track all jobs
  scheduledJobs.set("dailyReset", dailyResetJob);

  // Start all jobs
  await dailyResetJob.start();
  log.debug("CentralResetService started");
}

async function processDailyResets() {
  const start = Date.now();
  const end = resetExecutionTimer.startTimer();
  const opId = OpId.rst();
  const ctx = { opId };

  log.debug("Daily reset start", ctx);

  await wrapWithAlerting(
    async () => {
      await db.transaction(async (db) => {
        const usersNeedingPotentialReset = await db
          .select({
            discordId: userTable.discordId,
            timezone: userTable.timezone,
            lastDailyReset: userTable.lastDailyReset,
          })
          .from(userTable);

        // Get guild members to filter out users who left
        const guildMemberIds = new Set<string>();
        for (const guild of client.guilds.cache.values()) {
          log.debug("Cache size before fetch", { guildId: guild.id, size: guild.members.cache.size, opId });
          const members = await guild.members.fetch();
          log.debug("Cache size after fetch", { guildId: guild.id, size: guild.members.cache.size, opId });
          for (const memberId of members.keys()) {
            guildMemberIds.add(memberId);
          }
        }

        // Filter to only include users who are still in guild and past their local midnight
        const usersNeedingReset = [];
        for (const user of usersNeedingPotentialReset) {
          if (!guildMemberIds.has(user.discordId)) continue;

          const userTime = dayjs().tz(user.timezone);
          const lastReset = dayjs(user.lastDailyReset).tz(user.timezone);

          if (!userTime.isSame(lastReset, "day")) {
            usersNeedingReset.push(user.discordId);
          }
        }

        if (usersNeedingReset.length === 0) {
          log.debug("No users need reset", ctx);
          return;
        }

        const usersInVoiceSessions = await fetchOpenVoiceSessions(db, usersNeedingReset);
        log.info("Users identified", {
          ...ctx,
          total: usersNeedingReset.length,
          inVoice: usersInVoiceSessions.map((s) => s.discordId).join(", "),
        });

        try {
          await Promise.all(usersInVoiceSessions.map((session) => endVoiceSession(session, db, opId)));

          const boostersUpdated = await setBoosterPerk(db, usersNeedingReset);
          if (boostersUpdated > 0) {
            log.debug("Boosters auto-credited", { ...ctx, count: boostersUpdated });
          }

          await loseMessageStreakInNickname(db, opId, ctx, usersNeedingReset);

          const result = await db
            .update(userTable)
            .set({
              dailyPoints: 0,
              dailyVoiceTime: 0,
              lastDailyReset: new Date(),
              messageStreak: sql`CASE WHEN ${userTable.isMessageStreakUpdatedToday} = false THEN 0 ELSE ${userTable.messageStreak} END`,
              isMessageStreakUpdatedToday: false,
              dailyMessages: 0,
            })
            .where(inArray(userTable.discordId, usersNeedingReset));
          log.info("Daily reset complete", { ...ctx, usersReset: result.rowCount, ms: Date.now() - start });
        } finally {
          await Promise.all(usersInVoiceSessions.map((session) => startVoiceSession(session, db, opId)));
        }
      });
    },
    "Daily reset processing",
    opId,
  );
  end({ action: "daily" });
}

async function setBoosterPerk(
  db: PgTransaction<NodePgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>>,
  usersNeedingReset: string[],
): Promise<number> {
  const boosters = await client.guilds
    .fetch(process.env.GUILD_ID)
    .then((guild) => guild.members.fetch())
    .then((members) =>
      members
        .filter((member) => member.premiumSince !== null && usersNeedingReset.includes(member.id))
        .map((member) => member.id),
    );

  if (boosters.length === 0) return 0;

  await db
    .update(userTable)
    .set({
      isMessageStreakUpdatedToday: true,
    })
    .where(inArray(userTable.discordId, boosters));

  return boosters.length;
}

async function loseMessageStreakInNickname(
  db: PgTransaction<NodePgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>>,
  opId: string,
  ctx: { opId: string },
  usersNeedingReset: string[],
) {
  const usersLosingStreak = await db
    .select({ discordId: userTable.discordId })
    .from(userTable)
    .where(and(inArray(userTable.discordId, usersNeedingReset), eq(userTable.isMessageStreakUpdatedToday, false)));

  if (usersLosingStreak.length > 0) {
    log.debug("Streaks being reset", {
      ...ctx,
      usersLosingStreak: usersLosingStreak.map((u) => u.discordId).join(", "),
    });
    for (const row of usersLosingStreak) {
      const members = client.guilds.cache.map((guild) => guild.members.fetch(row.discordId).catch(() => null));
      await Promise.all(
        members.map(async (m) => {
          await updateMessageStreakInNickname(await m, 0, opId);
        }),
      );
    }
  }
}
