import { ChatInputCommandInteraction, type GuildMember, type Message, type MessageEditOptions } from "discord.js";
import assert from "node:assert/strict";
import type { House } from "../types.ts";
import { eq, inArray, sql, type ExtractTablesWithRelations } from "drizzle-orm";
import { houseScoreboardTable, userTable } from "../db/schema.ts";
import type { Schema } from "../db/db.ts";
import type { PgTransaction } from "drizzle-orm/pg-core";
import type { NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import { BOT_COLORS } from "./constants.ts";
import { client } from "../client.ts";
import { getHousepointMessage } from "../commands/scoreboard.ts";
import { alertOwner } from "./alerting.ts";
import { createLogger } from "./logger.ts";

const log = createLogger("Utils");

// Cache for message fetches (persists between awardPoints calls)
const messageCache = new Map<string, Message>();

export interface ScoreboardEntry {
  id: number;
  channelId: string;
  messageId: string;
  house: House;
}

/** Updates scoreboard messages, returns IDs of broken entries that should be deleted */
export async function updateScoreboardMessages(
  db: PgTransaction<NodePgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>> | typeof import("../db/db.ts").db,
  scoreboards: ScoreboardEntry[],
  opId: string,
): Promise<number[]> {
  const start = Date.now();
  const brokenIds: number[] = [];
  const houseScoreboardCache = new Map<House, MessageEditOptions>();

  for (const scoreboard of scoreboards) {
    // Compute house message data once per house
    if (!houseScoreboardCache.has(scoreboard.house)) {
      houseScoreboardCache.set(scoreboard.house, await getHousepointMessage(db, scoreboard.house, opId));
    }
    const scoreboardText = houseScoreboardCache.get(scoreboard.house);
    assert(scoreboardText, "House message data should be cached at this point");

    // Try cached message first
    const cachedMessage = messageCache.get(scoreboard.messageId);
    if (cachedMessage) {
      try {
        const editStart = Date.now();
        await cachedMessage.edit(scoreboardText);
        log.debug("Message edit (cached)", { opId, msgId: scoreboard.messageId, ms: Date.now() - editStart });
        continue;
      } catch {
        log.warn("Cached message edit failed, refetching", {
          opId,
          messageId: scoreboard.messageId,
          channelId: scoreboard.channelId,
        });
        messageCache.delete(scoreboard.messageId);
      }
    }

    // Fetch fresh and retry
    try {
      const fetchStart = Date.now();
      const channel = await client.channels.fetch(scoreboard.channelId);
      if (!channel?.isTextBased()) {
        brokenIds.push(scoreboard.id);
        continue;
      }
      const message = await channel.messages.fetch(scoreboard.messageId);
      messageCache.set(scoreboard.messageId, message);
      await message.edit(scoreboardText);
      log.debug("Message edit (fetched)", { opId, msgId: scoreboard.messageId, ms: Date.now() - fetchStart });
    } catch (e) {
      log.error(
        "Failed to update scoreboard message",
        { opId, messageId: scoreboard.messageId, channelId: scoreboard.channelId },
        e,
      );
      brokenIds.push(scoreboard.id);
      messageCache.delete(scoreboard.messageId);
    }
  }

  log.debug("updateScoreboardMessages", { opId, count: scoreboards.length, ms: Date.now() - start });
  return brokenIds;
}

export function getHouseFromMember(member: GuildMember | null): House | undefined {
  let house: House | undefined = undefined;
  if (member === null) return house;

  if (member.roles.cache.has(process.env.GRYFFINDOR_ROLE_ID)) {
    house = "Gryffindor";
  }
  if (member.roles.cache.has(process.env.SLYTHERIN_ROLE_ID)) {
    assert(
      house === undefined,
      `member ${member.user.tag} has multiple house roles: ${member.roles.cache.map((r) => r.name).join(", ")}`,
    );
    house = "Slytherin";
  }
  if (member.roles.cache.has(process.env.HUFFLEPUFF_ROLE_ID)) {
    assert(
      house === undefined,
      `member ${member.user.tag} has multiple house roles: ${member.roles.cache.map((r) => r.name).join(", ")}`,
    );
    house = "Hufflepuff";
  }
  if (member.roles.cache.has(process.env.RAVENCLAW_ROLE_ID)) {
    assert(
      house === undefined,
      `member ${member.user.tag} has multiple house roles: ${member.roles.cache.map((r) => r.name).join(", ")}`,
    );
    house = "Ravenclaw";
  }
  return house;
}

export async function awardPoints(
  db: PgTransaction<NodePgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>> | typeof import("../db/db.ts").db,
  discordId: string,
  points: number,
  opId: string,
) {
  // Update user's total points
  const house = await db
    .update(userTable)
    .set({
      dailyPoints: sql`${userTable.dailyPoints} + ${points}`,
      monthlyPoints: sql`${userTable.monthlyPoints} + ${points}`,
      totalPoints: sql`${userTable.totalPoints} + ${points}`,
    })
    .where(eq(userTable.discordId, discordId))
    .returning({ house: userTable.house })
    .then(([row]) => row?.house);

  if (house) {
    const scoreboards = await db.select().from(houseScoreboardTable).where(eq(houseScoreboardTable.house, house));
    const brokenIds = await updateScoreboardMessages(db, scoreboards, opId);
    if (brokenIds.length > 0) {
      await alertOwner(`Removed ${brokenIds.length} broken house scoreboard message entries for house ${house}.`, opId);
      await db.delete(houseScoreboardTable).where(inArray(houseScoreboardTable.id, brokenIds));
    }
  }
}

export async function replyError(
  opId: string,
  interaction: ChatInputCommandInteraction,
  title: string,
  ...messages: string[]
) {
  log.warn("Error reply", { opId, user: interaction.user.username, title, msg: messages.join("; ") });
  await interaction.editReply({
    embeds: [
      {
        color: BOT_COLORS.ERROR,
        title: `❌ ${title}`,
        description: messages.join("\n"),
      },
    ],
  });
}

export async function updateMessageStreakInNickname(
  member: GuildMember | null,
  newStreak: number,
  opId: string,
): Promise<void> {
  // Can't update nickname of guild owner
  if (!member || member.guild.ownerId === member.user.id || hasAnyRole(member, Role.PROFESSOR)) return;

  // If member has no nickname, no need to reset
  if (newStreak == 0 && member.nickname === null) return;

  let newNickname =
    member.nickname?.replace(/⚡\d+(?=[^⚡]*$)/, newStreak === 0 ? "" : `⚡${newStreak}`).trim() ??
    member.user.globalName ??
    member.user.displayName;

  // If no existing streak found, append it
  if (newStreak !== 0 && !/⚡\d+/.exec(newNickname)) {
    newNickname += ` ⚡${newStreak}`;
  }

  if (newNickname.length > 32) {
    log.debug("Nickname too long", { opId, user: member.user.tag, nickname: newNickname });
    return;
  }

  if (newNickname !== member.nickname) {
    log.debug("Updating nickname", {
      opId,
      user: member.user.tag,
      from: member.nickname ?? "NO_NICKNAME",
      to: newNickname,
    });
    await member.setNickname(newNickname);
  }
}

export const Role = {
  OWNER: 1 << 0,
  PREFECT: 1 << 1,
  PROFESSOR: 1 << 2,
} as const;

export function hasAnyRole(member: GuildMember, roles: number): boolean {
  let memberRoles = 0;
  if (member.id === process.env.OWNER_ID) memberRoles |= Role.OWNER;
  if (member.roles.cache.has(process.env.PREFECT_ROLE_ID)) memberRoles |= Role.PREFECT;
  if (member.roles.cache.has(process.env.PROFESSOR_ROLE_ID)) memberRoles |= Role.PROFESSOR;
  return (memberRoles & roles) !== 0;
}

export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
