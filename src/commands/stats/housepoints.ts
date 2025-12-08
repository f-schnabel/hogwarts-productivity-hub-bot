import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import { db } from "../../db/db.ts";
import { and, desc, eq, gt } from "drizzle-orm";
import { userTable } from "../../db/schema.ts";
import type { Command, House } from "../../types.ts";
import { HOUSE_COLORS } from "../../utils/constants.ts";
import { client } from "../../client.ts";

export default {
  data: new SlashCommandBuilder()
    .setName("housepoints")
    .setDescription("View house point leaderboards and champions")
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
  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply();

    const house = interaction.options.getString("house", true) as House;

    await replyHousepoints(interaction, house);
  },
} as Command;

async function replyHousepoints(interaction: ChatInputCommandInteraction, house: House) {
  const leaderboard = await db
    .select()
    .from(userTable)
    .where(and(eq(userTable.house, house), gt(userTable.monthlyPoints, 0)))
    .orderBy(desc(userTable.monthlyPoints));

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

  // Find the longest username (capped at 32 characters)
  const maxNameLength = Math.min(32, Math.max(...leaderboard.map((user) => user.username.length)));
  const medalPadding = leaderboard.length.toFixed(0).length + 1;

  // Create table header
  let description = "```\n";
  const header = `${"#".padStart(medalPadding)} ${"Name".padEnd(maxNameLength)}  Points`;
  description += `${header}\n`;
  description += "━".repeat(header.length) + "\n";

  // Add each user row
  leaderboard.forEach((user, index) => {
    const position = index + 1;

    const medals = ["🥇", "🥈", "🥉"];
    const medal = medals[position - 1] ?? `${position}`;
    const name = user.username.substring(0, 32).padEnd(maxNameLength);
    const points = user.monthlyPoints.toString().padStart(6);

    description += `${medal.padStart(medalPadding)} ${name}  ${points}\n`;
  });

  description += "```";

  await interaction.editReply({
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
          })}`,
        },
      },
    ],
  });
}
