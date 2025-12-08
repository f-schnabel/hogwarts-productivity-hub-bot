import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import { replyError } from "../../utils/utils.ts";
import { db } from "../../db/db.ts";
import { and, desc, eq, gt } from "drizzle-orm";
import { userTable } from "../../db/schema.ts";
import type { Command, House } from "../../types.ts";
import { HOUSE_COLORS } from "../../utils/constants.ts";

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

    const houseLeaderboard = await db
      .select()
      .from(userTable)
      .where(and(eq(userTable.house, house), gt(userTable.monthlyPoints, 0)))
      .orderBy(desc(userTable.monthlyPoints));

    if (houseLeaderboard.length === 0) {
      await replyError(
        interaction,
        "No House Data",
        "No house data is available yet. Houses need to earn points first!",
        "Join a voice channel and complete tasks to start earning house points. House points are awarded for voice time and task completion.",
      );
      return;
    }

    await replyHousepoints(interaction, houseLeaderboard, house);
  },
} as Command;

async function replyHousepoints(
  interaction: ChatInputCommandInteraction,
  leaderboard: (typeof userTable.$inferSelect)[],
  house: House,
) {
  // Find the longest username (capped at 32 characters)
  const maxNameLength = Math.min(32, Math.max(...leaderboard.map((user) => user.username.length)));
  const medalPadding = leaderboard.length.toFixed(0).length + 1;

  // Create table header
  let description = "```\n";
  description += `${"#".padStart(medalPadding - 1)} ${"Name".padEnd(maxNameLength)}  Points\n`;
  description += "━".repeat(maxNameLength + 11) + "\n";

  // Add each user row
  leaderboard.forEach((user, index) => {
    const position = index + 1;

    const medals = ["🥇", "🥈", "🥉"];
    const medal = medals[position - 1] ?? `#${position}`;
    const name = user.username.substring(0, 32).padEnd(maxNameLength);
    const points = user.monthlyPoints.toString().padStart(6);

    description += `${medal.padStart(2)} ${name}  ${points}\n`;
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
