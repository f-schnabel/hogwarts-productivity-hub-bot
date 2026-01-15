import type { Client, Guild } from "discord.js";
import dayjs from "dayjs";
import { commands } from "../commands.ts";
import * as VoiceStateScanner from "../services/voiceStateScanner.ts";
import { alertOwner } from "../utils/alerting.ts";
import { db, getVCEmoji } from "../db/db.ts";
import { houseScoreboardTable, userTable } from "../db/schema.ts";
import { gt, inArray } from "drizzle-orm";
import { VCEmojiNeedsRemovalSync, updateMessageStreakInNickname } from "../utils/nicknameUtils.ts";
import { getHousepointMessages, updateScoreboardMessages } from "../services/scoreboardService.ts";
import { createLogger, OpId } from "../utils/logger.ts";
import assert from "node:assert";
import { client } from "../client.ts";
import { MIN_USERS_FOR_SAFE_DELETION } from "../utils/constants.ts";
import { VCRoleNeedsRemovalSync } from "../utils/roleUtils.ts";
import { updateMember } from "./voiceStateUpdate.ts";

const log = createLogger("Startup");

export function getGuild(): Guild {
  const guild = client.guilds.cache.get(process.env.GUILD_ID);
  assert(guild, "Guild not initialized yet");
  return guild;
}

export async function execute(c: Client<true>): Promise<void> {
  const opId = OpId.start();

  log.info("Bot starting", { opId, user: c.user.tag, clientId: c.user.id, commands: commands.size });

  try {
    // fetch all members to ensure cache is populated
    for (const guild of c.guilds.cache.values()) {
      await guild.members.fetch();
    }

    await VoiceStateScanner.scanAndStartTracking(opId);
    await resetNicknameStreaks(c, opId);
    await resetVCEmojisAndRoles(c, opId);
    const { staleUserIds, totalDbUsers } = await logDbUserRetention(opId);
    await deleteStaleUsers(staleUserIds, totalDbUsers, opId);
    await refreshScoreboardMessages(opId);
  } catch (error) {
    log.error("Initialization failed", { opId }, error);
    process.exit(1);
  }
  log.info("Bot ready", { opId });
  await alertOwner("Bot deployed successfully.", opId);
}

async function logDbUserRetention(opId: string): Promise<{ staleUserIds: string[]; totalDbUsers: number }> {
  const oneMonthAgo = dayjs().subtract(1, "month").toDate();

  const dbUsers = await db.select({ discordId: userTable.discordId, updatedAt: userTable.updatedAt }).from(userTable);

  // Use cache since resetNicknameStreaks already fetched all members
  const guildMemberIds = new Set(getGuild().members.cache.keys());

  const foundCount = dbUsers.filter((u) => guildMemberIds.has(u.discordId)).length;
  const percentage = dbUsers.length > 0 ? ((foundCount / dbUsers.length) * 100).toFixed(1) : "0";
  log.info("DB user retention", { opId, found: foundCount, total: dbUsers.length, pct: `${percentage}%` });

  // If less than 100 users found, alert and skip deletion (likely guild cache is broken)
  if (foundCount < MIN_USERS_FOR_SAFE_DELETION) {
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
  const scoreboards = await db.select().from(houseScoreboardTable);
  if (scoreboards.length === 0) return;

  const brokenIds = await updateScoreboardMessages(await getHousepointMessages(db, scoreboards), opId);

  if (brokenIds.length > 0) {
    await db.delete(houseScoreboardTable).where(inArray(houseScoreboardTable.id, brokenIds));
    await alertOwner(`Removed ${brokenIds.length} broken scoreboard entries on startup.`, opId);
  }
  log.info("Scoreboards refreshed", {
    opId,
    refreshed: scoreboards.length - brokenIds.length,
    broken: brokenIds.length,
  });
}

async function resetNicknameStreaks(client: Client, opId: string) {
  log.debug("Resetting nickname streaks", { opId, guildsCache: client.guilds.cache.size });

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

  const guild = getGuild();

  const membersToReset = guild.members.cache.filter(
    (member) =>
      !discordIds.has(member.id) && member.guild.ownerId !== member.user.id && member.nickname?.match(/⚡\d+$/),
  );
  const membersToUpdate = guild.members.cache.filter(
    (member) => discordIds.has(member.id) && !member.nickname?.endsWith(` ⚡${String(discordIdsToStreak[member.id])}`),
  );

  log.debug("Processing guild nicknames", {
    opId,
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

async function resetVCEmojisAndRoles(c: Client<true>, opId: string) {
  log.debug("Resetting VC emojis", { opId, guildsCache: c.guilds.cache.size });
  const emoji = await getVCEmoji();
  const guild = getGuild();
  const role = guild.roles.cache.get(process.env.VC_ROLE_ID);
  if (!role) {
    await alertOwner("VC role not found: " + process.env.VC_ROLE_ID, opId);
    return;
  }

  const membersToReset = guild.members.cache.filter((m) => m.voice.channel === null);

  await Promise.all(
    membersToReset.map(async (member) => {
      const ctx = { opId, userId: member.id, username: member.user.username };

      await updateMember({
        member,
        reason: "Resetting VC emoji and role on startup",
        nickname: VCEmojiNeedsRemovalSync(ctx, member, emoji),
        roleUpdates: {
          rolesToRemove: VCRoleNeedsRemovalSync(ctx, member, role),
        },
      });
    }),
  );
}
