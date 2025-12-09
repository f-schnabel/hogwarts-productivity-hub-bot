import { ChatInputCommandInteraction, type GuildMember } from "discord.js";
import assert from "node:assert/strict";
import type { House } from "../types.ts";
import { eq, inArray, sql, type ExtractTablesWithRelations } from "drizzle-orm";
import { housePointsTable, houseScoreboardTable, userTable } from "../db/schema.ts";
import type { Schema } from "../db/db.ts";
import type { PgTransaction } from "drizzle-orm/pg-core";
import type { NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import { BotColors } from "./constants.ts";
import { client } from "../client.ts";
import { updateHousepoints } from "../commands/stats/scoreboard.ts";
import { alertOwner } from "./alerting.ts";

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
    await db
      .update(housePointsTable)
      .set({
        points: sql`${housePointsTable.points} + ${points}`,
      })
      .where(eq(housePointsTable.house, house));

    const messages = await db.select().from(houseScoreboardTable).where(eq(houseScoreboardTable.house, house));
    const brokenMessages = [];
    for (const msg of messages) {
      try {
        const channel = await client.channels.fetch(msg.channelId);
        if (!channel?.isTextBased()) {
          brokenMessages.push(msg.id);
          continue;
        }
        const message = await channel.messages.fetch(msg.messageId);
        await updateHousepoints(message, house);
      } catch (e) {
        console.error(`Failed to update housepoints message ${msg.messageId} in channel ${msg.channelId}:`, e);
        brokenMessages.push(msg.id);
      }
    }
    if (brokenMessages.length > 0) {
      await alertOwner(`Removed ${brokenMessages.length} broken house scoreboard message entries for house ${house}.`);
      await db.delete(houseScoreboardTable).where(inArray(houseScoreboardTable.id, brokenMessages));
    }
  }
}

export async function replyError(interaction: ChatInputCommandInteraction, title: string, ...messages: string[]) {
  await interaction.editReply({
    embeds: [
      {
        color: BotColors.ERROR,
        title: `❌ ${title}`,
        description: messages.join("\n"),
      },
    ],
  });
}

export function timeToHours(seconds: number | null): string {
  if (seconds === null) return "0h 0m";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

export async function updateMessageStreakInNickname(member: GuildMember | null, newStreak: number): Promise<void> {
  // Can't update nickname of guild owner
  if (!member || member.guild.ownerId === member.user.id || isProfessor(member)) return;

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
    console.warn(`Nickname for ${member.user.tag} is too long (${newNickname}). Ignoring update.`);
    return;
  }

  if (newNickname !== member.nickname) {
    console.log(`Updating nickname from ${member.nickname ?? "NO NICKNAME"} to ${newNickname}`);
    await member.setNickname(newNickname);
  }
}

export function isOwner(member: GuildMember): boolean {
  return member.id === process.env.OWNER_ID;
}

export function isPrefect(member: GuildMember): boolean {
  return member.roles.cache.has(process.env.PREFECT_ROLE_ID);
}

export function isProfessor(member: GuildMember): boolean {
  return member.roles.cache.has(process.env.PROFESSOR_ROLE_ID);
}

export function isPrefectOrProfessor(member: GuildMember): boolean {
  return member.roles.cache.hasAny(process.env.PREFECT_ROLE_ID, process.env.PROFESSOR_ROLE_ID);
}
