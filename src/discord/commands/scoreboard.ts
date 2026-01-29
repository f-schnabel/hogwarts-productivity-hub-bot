import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import { db } from "@/db/db.ts";
import { houseScoreboardTable } from "@/db/schema.ts";
import type { Command, CommandOptions, House } from "@/common/types.ts";
import { inGuild, requireRole } from "@/discord/utils/interactionUtils.ts";
import { getHousepointMessages } from "@/discord/utils/scoreboardService.ts";
import assert from "node:assert";
import { Role } from "@/common/constants.ts";

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
    if (!inGuild(interaction, opId) || !requireRole(interaction, opId, Role.OWNER | Role.PROFESSOR)) return;
    await interaction.deferReply();

    const house = interaction.options.getString("house", true) as House;
    await db.transaction(async (db) => {
      const [scoreboardMessage] = await getHousepointMessages(db, [{ house }]);
      assert(scoreboardMessage, `No scoreboard found for house ${house}`);
      const message = await interaction.editReply(scoreboardMessage.message);

      await db.insert(houseScoreboardTable).values({
        house,
        channelId: message.channelId,
        messageId: message.id,
      });
    });
  },
} as Command;
