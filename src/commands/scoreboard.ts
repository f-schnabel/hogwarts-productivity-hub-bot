import { ChatInputCommandInteraction, GuildMember, SlashCommandBuilder, type MessageEditOptions } from "discord.js";
import { db, type Schema } from "../db/db.ts";
import { and, desc, eq, gt, type ExtractTablesWithRelations } from "drizzle-orm";
import { houseScoreboardTable, userTable } from "../db/schema.ts";
import type { Command, CommandOptions, House } from "../types.ts";
import { HOUSE_COLORS } from "../utils/constants.ts";
import { client } from "../client.ts";
import { hasAnyRole, replyError, Role } from "../utils/utils.ts";
import type { PgTransaction } from "drizzle-orm/pg-core";
import type { NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import { createLogger } from "../utils/logger.ts";

const log = createLogger("Scoreboard");

export default {
  data: new SlashCommandBuilder()
    .setName("scoreboard")
    .setDescription("View scoreboards for a house")
    .addStringOption((option) =>
      option
        .setName("house")
        .setDescription("Choose a house to view its points")
        .setRequired(true)
        .addChoices(
          { name: "Slytherin", value: "Slytherin" },
          { name: "Gryffindor", value: "Gryffindor" },
          { name: "Hufflepuff", value: "Hufflepuff" },
          { name: "Ravenclaw", value: "Ravenclaw" },
        ),
    ),
  async execute(interaction: ChatInputCommandInteraction, { opId }: CommandOptions) {
    await interaction.deferReply();
    const member = interaction.member as GuildMember;

    if (!hasAnyRole(member, Role.OWNER | Role.PROFESSOR)) {
      await replyError(opId, interaction, "Access Denied", "You do not have permission to use this command.");
      return;
    }

    const house = interaction.options.getString("house", true) as House;
    await db.transaction(async (db) => {
      const scoreboardMessage = await getHousepointMessage(db, house, opId);
      const message = await interaction.editReply(scoreboardMessage);

      await db.insert(houseScoreboardTable).values({
        house,
        channelId: message.channelId,
        messageId: message.id,
      });
    });
  },
} as Command;

export async function getHousepointMessage(
  db: PgTransaction<NodePgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>> | typeof import("../db/db.ts").db,
  house: House,
  opId: string,
): Promise<MessageEditOptions> {
  const leaderboard = await db
    .select()
    .from(userTable)
    .where(and(eq(userTable.house, house), gt(userTable.monthlyPoints, 0)))
    .orderBy(desc(userTable.monthlyPoints));

  const fetchStart = Date.now();
  for (const row of leaderboard) {
    const members = client.guilds.cache.map((guild) => guild.members.fetch(row.discordId).catch(() => null));
    await Promise.all(
      members.map(async (m) => {
        const member = await m;
        if (!member) return;
        row.username = member.nickname ?? member.user.globalName ?? member.user.username;
      }),
    );
  }
  log.debug("Member fetch", { opId, house, users: leaderboard.length, ms: Date.now() - fetchStart });

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
