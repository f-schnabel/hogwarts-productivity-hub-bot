import { ChatInputCommandInteraction, GuildMember, Message, SlashCommandBuilder } from "discord.js";
import { db } from "../../db/db.ts";
import { and, desc, eq, gt } from "drizzle-orm";
import { houseScoreboardTable, userTable } from "../../db/schema.ts";
import type { Command, House } from "../../types.ts";
import { HOUSE_COLORS } from "../../utils/constants.ts";
import { client } from "../../client.ts";
import { isOwner, isProfessor, replyError } from "../../utils/utils.ts";
import assert from "assert";

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
    const message = (await interaction.deferReply({ withResponse: true })).resource?.message;
    assert(message, "Failed to retrieve message after deferring reply");
    const member = interaction.member as GuildMember;

    if (!isProfessor(member) && !isOwner(member)) {
      await replyError(interaction, "Access Denied", "You do not have permission to use this command.");
      return;
    }

    const house = interaction.options.getString("house", true) as House;

    await updateHousepoints(message, house);

    await db.insert(houseScoreboardTable).values({
      house,
      channelId: interaction.channelId,
      messageId: interaction.id,
    });
  },
} as Command;

export async function updateHousepoints(message: Message, house: House) {
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

  const medalPadding = leaderboard.length.toString().length + 1;
  const longestNameLength = Math.min(Math.max(...leaderboard.map((user) => user.username.length)), 32);

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

  await message.edit({
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
