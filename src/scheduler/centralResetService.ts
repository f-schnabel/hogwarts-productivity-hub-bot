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
  console.log("CentralResetService started successfully");
}

async function processDailyResets() {
  const end = resetExecutionTimer.startTimer();
  console.debug("+".repeat(5) + " Processing daily resets at " + dayjs().format("MMM DD HH:mm:ss"));

  await wrapWithAlerting(async () => {
    await db.transaction(async (db) => {
      const usersNeedingPotentialReset = await db
        .select({
          discordId: userTable.discordId,
          timezone: userTable.timezone,
          lastDailyReset: userTable.lastDailyReset,
        })
        .from(userTable);

      // Filter to only include users who are actually past their local midnight
      const usersNeedingReset = [];
      for (const user of usersNeedingPotentialReset) {
        const userTime = dayjs().tz(user.timezone);
        const lastReset = dayjs(user.lastDailyReset).tz(user.timezone);

        if (!userTime.isSame(lastReset, "day")) {
          usersNeedingReset.push(user.discordId);
        }
      }

      if (usersNeedingReset.length === 0) {
        console.log("No users need daily reset at this time");
        return;
      }

      const usersInVoiceSessions = await fetchOpenVoiceSessions(db, usersNeedingReset);

      await Promise.all(usersInVoiceSessions.map((session) => endVoiceSession(session, db)));

      await setBoosterPerk(db, usersNeedingReset);

      await db
        .select()
        .from(userTable)
        .where(and(inArray(userTable.discordId, usersNeedingReset), eq(userTable.isMessageStreakUpdatedToday, false)))
        .then(async (rows) => {
          for (const row of rows) {
            const members = client.guilds.cache.map((guild) => guild.members.fetch(row.discordId).catch(() => null));
            await Promise.all(
              members.map(async (m) => {
                await updateMessageStreakInNickname(await m, 0);
              }),
            );
          }
        });

      const result = await db
        .update(userTable)
        .set({
          dailyPoints: 0,
          dailyVoiceTime: 0,
          lastDailyReset: new Date(),
          voiceStreak: sql`CASE WHEN ${userTable.isVoiceStreakUpdatedToday} = false THEN 0 ELSE ${userTable.voiceStreak} END`,
          isVoiceStreakUpdatedToday: false,
          messageStreak: sql`CASE WHEN ${userTable.isMessageStreakUpdatedToday} = false THEN 0 ELSE ${userTable.messageStreak} END`,
          isMessageStreakUpdatedToday: false,
          dailyMessages: 0,
        })
        .where(inArray(userTable.discordId, usersNeedingReset));

      await Promise.all(usersInVoiceSessions.map((session) => startVoiceSession(session, db)));

      console.log("Daily reset edited this many users:", result.rowCount);
    });
  }, "Daily reset processing");
  console.debug("-".repeat(5));
  end({ action: "daily" });
}

async function setBoosterPerk(
  db: PgTransaction<NodePgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>>,
  usersNeedingReset: string[],
) {
  const boosters = await client.guilds
    .fetch(process.env.GUILD_ID)
    .then((guild) => guild.members.fetch())
    .then((members) =>
      members
        .filter((member) => member.premiumSince !== null && usersNeedingReset.includes(member.id))
        .map((member) => member.id),
    );

  await db
    .update(userTable)
    .set({
      isMessageStreakUpdatedToday: true,
    })
    .where(inArray(userTable.discordId, boosters));
}
