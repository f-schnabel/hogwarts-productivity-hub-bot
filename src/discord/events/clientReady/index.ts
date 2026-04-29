import type { Client, Guild } from "discord.js";
import dayjs from "dayjs";
import { commands } from "@/discord/commands.ts";
import * as VoiceStateScanner from "@/discord/events/clientReady/voiceStateScanner.ts";
import { alertOwner } from "@/discord/utils/alerting.ts";
import { db, getVCEmoji } from "@/db/db.ts";
import { houseScoreboardTable, userTable } from "@/db/schema.ts";
import { gt, inArray } from "drizzle-orm";
import { updateMessageStreakInNickname } from "@/discord/core/nicknameStreak.ts";
import { getHousepointMessages, updateScoreboardMessages } from "@/discord/events/interactionCreate/scoreboard/scoreboard.ts";
import { createLogger } from "@/common/logging/logger.ts";
import assert from "node:assert";
import { client } from "@/discord/client.ts";
import { MIN_USERS_FOR_SAFE_DELETION } from "@/common/constants.ts";
import { updateMember } from "@/discord/utils/updateMember.ts";
import { VCEmojiNeedsRemovalSync } from "@/discord/core/nicknameVC.ts";
import { VCRoleNeedsRemovalSync } from "@/discord/core/roleVC.ts";
import { restorePomodoroSessions } from "@/discord/utils/pomodoroUtils.ts";

const log = createLogger("Startup");

export function getGuild(): Guild {
  const guild = client.guilds.cache.get(process.env.GUILD_ID);
  assert(guild, "Guild not initialized yet");
  return guild;
}

export async function execute(c: Client<true>): Promise<void> {
  log.info("Bot starting", { user: c.user.tag, clientId: c.user.id, commands: commands.size });

  try {
    // fetch all members to ensure cache is populated
    for (const guild of c.guilds.cache.values()) {
      await guild.members.fetch();
    }

    await warmRecentSubmissionMessages(c);
    await restorePomodoroSessions();
    await VoiceStateScanner.scanAndStartTracking();
    await resetNicknameStreaks(c);
    await resetVCEmojisAndRoles(c);
    const { staleUserIds, totalDbUsers } = await logDbUserRetention();
    await deleteStaleUsers(staleUserIds, totalDbUsers);
    await refreshScoreboardMessages();
  } catch (error) {
    log.error("Initialization failed", {}, error);
    process.exit(1);
  }
  log.info("Bot ready");
  await alertOwner("Bot deployed successfully.");
}

// Warm recent submission messages into cache so reaction-based reopen works without partials.
async function warmRecentSubmissionMessages(client: Client<true>) {
  const cutoffMs = dayjs().subtract(2, "day").valueOf();

  for (const channelId of process.env.SUBMISSION_CHANNEL_IDS.split(",").filter(Boolean)) {
    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel?.isTextBased()) {
        log.warn("Skipping non-text submission channel during cache warmup", { channelId });
        continue;
      }

      let before: string | undefined;
      let cachedMessages = 0;
      let shouldContinue = true;

      while (shouldContinue) {
        const messages = await channel.messages.fetch({ limit: 100, before });
        if (messages.size === 0) break;

        cachedMessages += messages.size;

        const oldestMessage = messages.last();
        if (!oldestMessage) break;

        shouldContinue = oldestMessage.createdTimestamp >= cutoffMs && messages.size === 100;
        before = oldestMessage.id;
      }

      log.info("Submission messages cache warmed", { channelId, cachedMessages });
    } catch (error) {
      log.error("Failed to warm submission message cache", { channelId }, error);
    }
  }
}

async function logDbUserRetention(): Promise<{ staleUserIds: string[]; totalDbUsers: number }> {
  const oneMonthAgo = dayjs().subtract(1, "month").toDate();

  const dbUsers = await db.select({ discordId: userTable.discordId, updatedAt: userTable.updatedAt }).from(userTable);

  // Use cache since resetNicknameStreaks already fetched all members
  const guildMemberIds = new Set(getGuild().members.cache.keys());

  const foundCount = dbUsers.filter((u) => guildMemberIds.has(u.discordId)).length;
  const percentage = dbUsers.length > 0 ? ((foundCount / dbUsers.length) * 100).toFixed(1) : "0";
  log.info("DB user retention", { found: foundCount, total: dbUsers.length, pct: `${percentage}%` });

  // If less than 100 users found, alert and skip deletion (likely guild cache is broken)
  if (foundCount < MIN_USERS_FOR_SAFE_DELETION) {
    await alertOwner(
      `Aborting stale user deletion: only ${foundCount}/${dbUsers.length} (${percentage}%) users found in guild cache.`,
    );
    return { staleUserIds: [], totalDbUsers: dbUsers.length };
  }

  // Return users not in server and not updated in over a month
  const staleUserIds = dbUsers
    .filter((u) => !guildMemberIds.has(u.discordId) && u.updatedAt < oneMonthAgo)
    .map((u) => u.discordId);
  return { staleUserIds, totalDbUsers: dbUsers.length };
}

async function deleteStaleUsers(staleUserIds: string[], totalDbUsers: number) {
  if (staleUserIds.length === 0) return;

  // Safety: don't delete if stale users are >50% of db (likely means guild cache is broken)
  const staleRatio = staleUserIds.length / totalDbUsers;
  if (staleRatio > 0.5) {
    log.warn("Skipping stale user deletion - too many stale", {
      stale: staleUserIds.length,
      total: totalDbUsers,
    });
    await alertOwner(`Skipped stale user deletion: ${staleUserIds.length}/${totalDbUsers} users stale (>50%)`);
    return;
  }

  // Cascades to voice_session, submission
  await db.delete(userTable).where(inArray(userTable.discordId, staleUserIds));
  log.info("Deleted stale users", { count: staleUserIds.length });
}

async function refreshScoreboardMessages() {
  const scoreboards = await db.select().from(houseScoreboardTable);
  if (scoreboards.length === 0) return;

  const brokenIds = await updateScoreboardMessages(await getHousepointMessages(db, scoreboards));

  if (brokenIds.length > 0) {
    await db.delete(houseScoreboardTable).where(inArray(houseScoreboardTable.id, brokenIds));
    await alertOwner(`Removed ${brokenIds.length} broken scoreboard entries on startup.`);
  }
  log.info("Scoreboards refreshed", {
    refreshed: scoreboards.length - brokenIds.length,
    broken: brokenIds.length,
  });
}

async function resetNicknameStreaks(client: Client) {
  log.debug("Resetting nickname streaks", { guildsCache: client.guilds.cache.size });

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
    guild: guild.name,
    membersCache: guild.members.cache.size,
    toReset: membersToReset.size,
    toUpdate: membersToUpdate.size,
  });

  await Promise.all([
    ...membersToReset.values().map(async (m) => {
      await updateMessageStreakInNickname(m, 0);
    }),
    ...membersToUpdate.values().map(async (m) => {
      const streak = discordIdsToStreak[m.id];
      if (streak === undefined) {
        throw new TypeError(`unreachable: Streak for member ${m.id} does not exist`);
      }
      await updateMessageStreakInNickname(m, streak);
    }),
  ]);
}

async function resetVCEmojisAndRoles(c: Client<true>) {
  log.debug("Resetting VC emojis", { guildsCache: c.guilds.cache.size });
  const emoji = await getVCEmoji();
  const guild = getGuild();
  const role = guild.roles.cache.get(process.env.VC_ROLE_ID);
  if (!role) {
    await alertOwner("VC role not found: " + process.env.VC_ROLE_ID);
    return;
  }

  const membersToReset = guild.members.cache.filter((m) => m.voice.channel === null);

  await Promise.all(
    membersToReset.map(async (member) => {
      await updateMember({
        member,
        reason: "Resetting VC emoji and role on startup",
        nickname: VCEmojiNeedsRemovalSync(member, emoji),
        roleUpdates: {
          rolesToRemove: VCRoleNeedsRemovalSync(member, role),
        },
      });
    }),
  );
}
