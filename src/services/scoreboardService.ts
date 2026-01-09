import { type MessageEditOptions } from "discord.js";
import assert from "node:assert/strict";
import { and, desc, eq, gt, type ExtractTablesWithRelations } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import type { NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import type { Schema } from "../db/db.ts";
import { userTable } from "../db/schema.ts";
import type { House } from "../types.ts";
import { HOUSE_COLORS } from "../utils/constants.ts";
import { client } from "../client.ts";
import { createLogger } from "../utils/logger.ts";

const log = createLogger("Scoreboard");

export interface ScoreboardEntry {
  id: number;
  channelId: string;
  messageId: string;
  house: House;
}

export async function getHousepointMessage(
  db: PgTransaction<NodePgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>> | typeof import("../db/db.ts").db,
  house: House,
): Promise<MessageEditOptions> {
  const leaderboard = await db
    .select()
    .from(userTable)
    .where(and(eq(userTable.house, house), gt(userTable.monthlyPoints, 0)))
    .orderBy(desc(userTable.monthlyPoints));

  for (const [, guild] of client.guilds.cache) {
    if (guild.id !== process.env.GUILD_ID) continue;

    for (const user of leaderboard) {
      const member = guild.members.cache.get(user.discordId);
      if (member) {
        user.username = member.nickname ?? member.user.globalName ?? member.user.username;
      }
    }
  }

  const medalPadding = leaderboard.length.toString().length + 1;
  const longestNameLength = leaderboard.length
    ? Math.min(Math.max(...leaderboard.map((user) => user.username.length)), 32)
    : 0;

  // Create table header
  let description = "```\n";
  description += `${"#".padStart(medalPadding)} ${"Points".padStart(6)}  Name\n`;
  description += "━".repeat(medalPadding + 6 + 2 + longestNameLength) + "\n";

  // Add each user row
  leaderboard.forEach((user, index) => {
    const position = index + 1;

    const medals = ["🥇", "🥈", "🥉"];
    const medal = medals[position - 1] ?? `${position}`;
    const points = user.monthlyPoints.toString().padStart(6);
    const name = user.username.substring(0, 32);

    description += `${medal.padStart(medalPadding)} ${points}  ${name}\n`;
  });

  description += "```";

  return {
    embeds: [
      {
        color: HOUSE_COLORS[house],
        title: house.toUpperCase(),
        description: description,
        footer: {
          text: `Last updated • ${new Date().toLocaleString("en-US", {
            month: "long",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
            hour12: true,
          })} UTC`,
        },
      },
    ],
  };
}

export async function updateScoreboardMessages(
  db: PgTransaction<NodePgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>> | typeof import("../db/db.ts").db,
  scoreboards: ScoreboardEntry[],
  opId: string,
): Promise<number[]> {
  const start = Date.now();
  const brokenIds: number[] = [];
  const houseScoreboard = new Map<House, MessageEditOptions>();
  for (const house of new Set(scoreboards.map((s) => s.house))) {
    houseScoreboard.set(house, await getHousepointMessage(db, house));
  }

  for (const scoreboard of scoreboards) {
    const scoreboardText = houseScoreboard.get(scoreboard.house);
    assert(scoreboardText, "House message data should be cached at this point");

    try {
      const fetchStart = Date.now();
      const channel = await client.channels.fetch(scoreboard.channelId);
      if (!channel?.isTextBased()) {
        brokenIds.push(scoreboard.id);
        continue;
      }
      const message = await channel.messages.fetch(scoreboard.messageId);
      await message.edit(scoreboardText);
      log.debug("Message edit", { opId, msgId: scoreboard.messageId, ms: Date.now() - fetchStart });
    } catch (e) {
      log.error(
        "Failed to update scoreboard message",
        { opId, messageId: scoreboard.messageId, channelId: scoreboard.channelId },
        e,
      );
      brokenIds.push(scoreboard.id);
    }
  }

  log.debug("updateScoreboardMessages", { opId, count: scoreboards.length, ms: Date.now() - start });
  return brokenIds;
}
