import { ChatInputCommandInteraction, GuildMember, SlashCommandBuilder } from "discord.js";
import { db } from "../../db/db.ts";
import { and, desc, eq, gt } from "drizzle-orm";
import { userTable } from "../../db/schema.ts";
import type { Command, House } from "../../types.ts";
import { HOUSE_COLORS } from "../../utils/constants.ts";
import { client } from "../../client.ts";
import { isOwner, isProfessor, replyError } from "../../utils/utils.ts";

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

// Calculate the visual display width of a string (emojis and special chars take ~2 spaces)
function getDisplayWidth(str: string): number {
  let width = 0;
  for (const { segment } of segmenter.segment(str)) {
    const code = segment.codePointAt(0) ?? 0;
    // Check if character is:
    // - emoji or special unicode (above 0x1F00)
    // - complex grapheme (multiple code points)
    // - small caps, modifier letters, phonetic extensions (0x1D00-0x1DBF)
    // - superscript/subscript letters (0x2070-0x209F)
    // - letter-like symbols (0x2100-0x214F)
    // - Latin Extended-D (0xA720-0xA7FF) - includes ꜱ
    // - Arabic characters (0x0600-0x06FF) - includes ݁
    // - CJK and other wide characters (0x1100+, 0x2E80+, 0x3000+, 0xFF00+)
    const isWideChar =
      code > 0x1f00 ||
      segment.length > 1 ||
      (code >= 0x1d00 && code <= 0x1dbf) ||
      (code >= 0x2070 && code <= 0x209f) ||
      (code >= 0x2100 && code <= 0x214f) ||
      (code >= 0xa720 && code <= 0xa7ff) ||
      (code >= 0x0600 && code <= 0x06ff) ||
      (code >= 0x0250 && code <= 0x02af); // IPA extensions (includes ɥ, ɹ, etc.)

    if (isWideChar) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

function padEndByDisplayWidth(str: string, targetWidth: number): string {
  const currentWidth = getDisplayWidth(str);
  const paddingNeeded = Math.max(0, targetWidth - currentWidth);
  return str + " ".repeat(paddingNeeded);
}

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

  // Find the longest username by display width (capped at 32 display chars)
  const maxNameWidth = Math.min(32, Math.max(...leaderboard.map((user) => getDisplayWidth(user.username))));
  const medalPadding = leaderboard.length.toFixed(0).length + 1;

  // Create table header
  let description = "```\n";
  const header = `${"#".padStart(medalPadding)} ${"Name".padEnd(maxNameWidth)}  Points`;
  description += `${header}\n`;
  description += "━".repeat(header.length) + "\n";

  // Add each user row
  leaderboard.forEach((user, index) => {
    const position = index + 1;

    const medals = ["🥇", "🥈", "🥉"];
    const medal = medals[position - 1] ?? `${position}`;
    let truncatedName = "";
    for (const { segment } of segmenter.segment(user.username)) {
      if (getDisplayWidth(truncatedName + segment) <= 32) {
        truncatedName += segment;
      } else {
        break;
      }
    }
    const name = padEndByDisplayWidth(truncatedName, maxNameWidth);
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
