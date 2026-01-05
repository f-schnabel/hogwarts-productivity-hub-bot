import type { Client } from "discord.js";
import { commands } from "../commands.ts";
import * as VoiceStateScanner from "../utils/voiceStateScanner.ts";
import { alertOwner } from "../utils/alerting.ts";
import { db } from "../db/db.ts";
import { houseScoreboardTable, userTable } from "../db/schema.ts";
import { gt, inArray } from "drizzle-orm";
import { updateMessageStreakInNickname } from "../utils/utils.ts";
import { getHousepointMessage } from "../commands/scoreboard.ts";
import type { House } from "../types.ts";
import { createLogger, OpId } from "../utils/logger.ts";

const log = createLogger("Startup");

export async function execute(c: Client<true>): Promise<void> {
  const opId = OpId.start();
  const ctx = { opId };

  log.info("Bot starting", { ...ctx, user: c.user.tag, clientId: c.user.id, commands: commands.size });

  try {
    await VoiceStateScanner.scanAndStartTracking(opId);
    await resetNicknameStreaks(c, opId);
    await logDbUserRetention(c, opId);
    await refreshScoreboardMessages(c, opId);
  } catch (error) {
    log.error("Initialization failed", ctx, error);
    process.exit(1);
  }
  log.info("Bot ready", ctx);
  await alertOwner("Bot deployed successfully.", opId);
}

async function logDbUserRetention(client: Client, opId: string) {
  const ctx = { opId };
  const dbUserIds = await db
    .select({ discordId: userTable.discordId })
    .from(userTable)
    .then((rows) => new Set(rows.map((r) => r.discordId)));

  // Use cache since resetNicknameStreaks already fetched all members
  const guildMemberIds = new Set<string>();
  for (const guild of client.guilds.cache.values()) {
    for (const memberId of guild.members.cache.keys()) {
      guildMemberIds.add(memberId);
    }
  }

  const foundCount = [...dbUserIds].filter((id) => guildMemberIds.has(id)).length;
  const percentage = dbUserIds.size > 0 ? ((foundCount / dbUserIds.size) * 100).toFixed(1) : "0";

  log.info("DB user retention", { ...ctx, found: foundCount, total: dbUserIds.size, pct: `${percentage}%` });
}

// TODO duplication with awardPoints in utils.ts
async function refreshScoreboardMessages(client: Client, opId: string) {
  const ctx = { opId };
  const scoreboards = await db.select().from(houseScoreboardTable);
  if (scoreboards.length === 0) return;

  const brokenIds: number[] = [];
  for (const scoreboard of scoreboards) {
    try {
      const channel = await client.channels.fetch(scoreboard.channelId);
      if (!channel?.isTextBased()) {
        brokenIds.push(scoreboard.id);
        continue;
      }
      const message = await channel.messages.fetch(scoreboard.messageId);
      const messageData = await getHousepointMessage(db, scoreboard.house as House);
      await message.edit(messageData);
    } catch (e) {
      log.error(
        "Scoreboard refresh failed",
        { ...ctx, messageId: scoreboard.messageId, channelId: scoreboard.channelId },
        e,
      );
      brokenIds.push(scoreboard.id);
    }
  }

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
        await updateMessageStreakInNickname(m, 0);
      }),
      ...membersToUpdate.values().map(async (m) => {
        const streak = discordIdsToStreak[m.id];
        if (typeof streak === "undefined") {
          throw new Error(`unreachable: Streak for member ${m.id} does not exist`);
        }
        await updateMessageStreakInNickname(m, streak);
      }),
    ]);
  }
}
