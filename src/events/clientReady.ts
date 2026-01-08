import type { Client } from "discord.js";
import dayjs from "dayjs";
import { commands } from "../commands.ts";
import * as VoiceStateScanner from "../utils/voiceStateScanner.ts";
import { alertOwner } from "../utils/alerting.ts";
import { db } from "../db/db.ts";
import { houseScoreboardTable, userTable } from "../db/schema.ts";
import { gt, inArray } from "drizzle-orm";
import { updateMessageStreakInNickname, updateScoreboardMessages } from "../utils/utils.ts";
import { createLogger, OpId } from "../utils/logger.ts";

const log = createLogger("Startup");

export async function execute(c: Client<true>): Promise<void> {
  const opId = OpId.start();
  const ctx = { opId };

  log.info("Bot starting", { ...ctx, user: c.user.tag, clientId: c.user.id, commands: commands.size });

  try {
    await VoiceStateScanner.scanAndStartTracking(opId);
    await resetNicknameStreaks(c, opId);
    const { staleUserIds, totalDbUsers } = await logDbUserRetention(c, opId);
    await deleteStaleUsers(staleUserIds, totalDbUsers, opId);
    await refreshScoreboardMessages(opId);
  } catch (error) {
    log.error("Initialization failed", ctx, error);
    process.exit(1);
  }
  log.info("Bot ready", ctx);
  await alertOwner("Bot deployed successfully.", opId);
}

async function logDbUserRetention(
  client: Client,
  opId: string,
): Promise<{ staleUserIds: string[]; totalDbUsers: number }> {
  const ctx = { opId };
  const oneMonthAgo = dayjs().subtract(1, "month").toDate();

  const dbUsers = await db.select({ discordId: userTable.discordId, updatedAt: userTable.updatedAt }).from(userTable);

  // Use cache since resetNicknameStreaks already fetched all members
  const guildMemberIds = new Set<string>();
  for (const guild of client.guilds.cache.values()) {
    for (const memberId of guild.members.cache.keys()) {
      guildMemberIds.add(memberId);
    }
  }

  const foundCount = dbUsers.filter((u) => guildMemberIds.has(u.discordId)).length;
  const percentage = dbUsers.length > 0 ? ((foundCount / dbUsers.length) * 100).toFixed(1) : "0";
  log.info("DB user retention", { ...ctx, found: foundCount, total: dbUsers.length, pct: `${percentage}%` });

  // If less than 100 users found, alert and skip deletion (likely guild cache is broken)
  if (foundCount < 100) {
    await alertOwner(
      `Aborting stale user deletion: only ${foundCount}/${dbUsers.length} (${percentage}%) users found in guild cache.`,
      opId,
    );
    return { staleUserIds: [], totalDbUsers: dbUsers.length };
  }

  // Return users not in server and not updated in over a month
  const staleUserIds = dbUsers
    .filter((u) => !guildMemberIds.has(u.discordId) && u.updatedAt < oneMonthAgo)
    .map((u) => u.discordId);
  return { staleUserIds, totalDbUsers: dbUsers.length };
}

async function deleteStaleUsers(staleUserIds: string[], totalDbUsers: number, opId: string) {
  if (staleUserIds.length === 0) return;

  // Safety: don't delete if stale users are >50% of db (likely means guild cache is broken)
  const staleRatio = staleUserIds.length / totalDbUsers;
  if (staleRatio > 0.5) {
    log.warn("Skipping stale user deletion - too many stale", {
      opId,
      stale: staleUserIds.length,
      total: totalDbUsers,
    });
    await alertOwner(`Skipped stale user deletion: ${staleUserIds.length}/${totalDbUsers} users stale (>50%)`, opId);
    return;
  }

  // Cascades to voice_session, submission
  await db.delete(userTable).where(inArray(userTable.discordId, staleUserIds));
  log.info("Deleted stale users", { opId, count: staleUserIds.length });
}

async function refreshScoreboardMessages(opId: string) {
  const ctx = { opId };
  const scoreboards = await db.select().from(houseScoreboardTable);
  if (scoreboards.length === 0) return;

  const brokenIds = await updateScoreboardMessages(db, scoreboards, opId);
  if (brokenIds.length > 0) {
    await db.delete(houseScoreboardTable).where(inArray(houseScoreboardTable.id, brokenIds));
    await alertOwner(`Removed ${brokenIds.length} broken scoreboard entries on startup.`, opId);
  }
  log.info("Scoreboards refreshed", {
    ...ctx,
    refreshed: scoreboards.length - brokenIds.length,
    broken: brokenIds.length,
  });
}

async function resetNicknameStreaks(client: Client, opId: string) {
  const ctx = { opId };
  log.debug("Resetting nickname streaks", { ...ctx, guildsCache: client.guilds.cache.size });

  const discordIdsToStreak = await db
    .select({
      discordId: userTable.discordId,
      messageStreak: userTable.messageStreak,
    })
    .from(userTable)
    .where(gt(userTable.messageStreak, 0))
    .then((rows) =>
      rows.reduce<Record<string, number>>((acc, r) => {
        acc[r.discordId] = r.messageStreak;
        return acc;
      }, {}),
    );
  const discordIds = new Set(Object.keys(discordIdsToStreak));

  for (const guild of client.guilds.cache.values()) {
    const membersToReset = await guild.members
      .fetch()
      .then((members) =>
        members.filter(
          (member) =>
            !discordIds.has(member.id) && member.guild.ownerId !== member.user.id && member.nickname?.match(/⚡\d+$/),
        ),
      );
    const membersToUpdate = guild.members.cache.filter(
      (member) =>
        discordIds.has(member.id) &&
        (!member.nickname?.endsWith(`⚡${String(discordIdsToStreak[member.id])}`) ||
          member.nickname.endsWith(` ⚡${String(discordIdsToStreak[member.id])}`)),
    );

    log.debug("Processing guild nicknames", {
      ...ctx,
      guild: guild.name,
      membersCache: guild.members.cache.size,
      toReset: membersToReset.size,
      toUpdate: membersToUpdate.size,
    });

    await Promise.all([
      ...membersToReset.values().map(async (m) => {
        await updateMessageStreakInNickname(m, 0, opId);
      }),
      ...membersToUpdate.values().map(async (m) => {
        const streak = discordIdsToStreak[m.id];
        if (streak === undefined) {
          throw new TypeError(`unreachable: Streak for member ${m.id} does not exist`);
        }
        await updateMessageStreakInNickname(m, streak, opId);
      }),
    ]);
  }
}
