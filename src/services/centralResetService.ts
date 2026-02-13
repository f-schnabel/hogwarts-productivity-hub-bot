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

          const boosterIds = getBoosterIds(guild, usersNeedingReset);
          if (boosterIds.size > 0) {
            log.debug("Boosters preserving streak", { opId, count: boosterIds.size });
          }

          await updateStreakNicknames(db, guild, opId, usersNeedingReset, boosterIds);

          // Met threshold → increment, booster (below threshold) → preserve, otherwise → reset
          const boosterGuard =
            boosterIds.size > 0
              ? sql`WHEN ${userTable.discordId} IN (${sql.join(
                  [...boosterIds].map((id) => sql`${id}`),
                  sql`, `,
                )}) THEN ${userTable.messageStreak}`
              : sql``;

          return await db
            .update(userTable)
            .set({
              dailyPoints: 0,
              dailyVoiceTime: 0,
              lastDailyReset: new Date(),
              messageStreak: sql`CASE WHEN ${userTable.dailyMessages} >= ${MIN_DAILY_MESSAGES_FOR_STREAK} THEN ${userTable.messageStreak} + 1 ${boosterGuard} ELSE 0 END`,
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

function getBoosterIds(guild: Guild, usersNeedingReset: string[]): Set<string> {
  const usersNeedingResetSet = new Set(usersNeedingReset);
  return new Set(
    guild.members.cache
      .filter((member) => member.premiumSince !== null && usersNeedingResetSet.has(member.id))
      .map((member) => member.id),
  );
}

async function updateStreakNicknames(
  db: Tx,
  guild: Guild,
  opId: string,
  usersNeedingReset: string[],
  boosterIds: Set<string>,
) {
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
          // Users losing streak (didn't meet threshold, not a booster, but had one)
          and(lt(userTable.dailyMessages, MIN_DAILY_MESSAGES_FOR_STREAK), gt(userTable.messageStreak, 0)),
        ),
      ),
    );

  if (users.length === 0) return;

  const gaining = users.filter((u) => u.dailyMessages >= MIN_DAILY_MESSAGES_FOR_STREAK);
  // Boosters below threshold keep their streak — no nickname change needed
  const losing = users.filter((u) => u.dailyMessages < MIN_DAILY_MESSAGES_FOR_STREAK && !boosterIds.has(u.discordId));

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
    [...gaining, ...losing].map(async (row) => {
      const member = guild.members.cache.get(row.discordId);
      if (!member) return;
      const newStreak = row.dailyMessages >= MIN_DAILY_MESSAGES_FOR_STREAK ? row.messageStreak + 1 : 0;
      await updateMessageStreakInNickname(member, newStreak, opId);
    }),
  );
}
