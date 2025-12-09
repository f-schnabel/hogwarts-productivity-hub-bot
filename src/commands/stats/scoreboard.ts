import { ChatInputCommandInteraction, GuildMember, SlashCommandBuilder } from "discord.js";
import { db } from "../../db/db.ts";
import { and, desc, eq, gt } from "drizzle-orm";
import { userTable } from "../../db/schema.ts";
import type { Command, House } from "../../types.ts";
import { isOwner, isProfessor, replyError } from "../../utils/utils.ts";

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
  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply();
    const member = interaction.member as GuildMember;

    if (!isProfessor(member) && !isOwner(member)) {
      await replyError(interaction, "Access Denied", "You do not have permission to use this command.");
      return;
    }

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

  let description = "";

  // Add each user row
  leaderboard.forEach((user, index) => {
    const position = index + 1;

    const medals = ["🥇", "🥈", "🥉"];
    const medal = medals[position - 1] ?? `#${position}`;
    const points = user.monthlyPoints;
    const mention = `<@${user.discordId}>`;

    description += `${medal} ${mention} • ${points} points\n`;
  });

  await interaction.editReply({
    content: description || "No points earned yet!",
    allowedMentions: { users: [] },
    //embeds: [
    //  {
    //    color: HOUSE_COLORS[house],
    //    title: house.toUpperCase(),
    //    description: ,
    //    footer: {
    //      text: `Last updated • ${new Date().toLocaleString("en-US", {
    //        month: "long",
    //        day: "numeric",
    //        hour: "numeric",
    //        minute: "2-digit",
    //        hour12: true,
    //      })}`,
    //    },
    //  },
    //],
  });
}
