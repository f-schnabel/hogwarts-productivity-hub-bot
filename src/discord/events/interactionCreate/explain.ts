import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import type { Command } from "@/common/types.ts";
import { BOT_COLORS } from "@/common/constants.ts";
import { errorReply } from "@/discord/utils/interaction.ts";
import { createLogger } from "@/common/logging/logger.ts";
import { generateExplanation, isOpenRouterConfigured } from "@/services/openRouterService.ts";

const log = createLogger("ExplainCommand");

export default {
  data: new SlashCommandBuilder()
    .setName("explain")
    .setDescription("Explain a concept or question with a light Hogwarts classroom style")
    .addStringOption((option) =>
      option
        .setName("question")
        .setDescription("The concept or question you want explained")
        .setRequired(true),
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    const question = interaction.options.getString("question", true).trim();

    if (question.length < 3) {
      await errorReply(interaction, "Question Too Short", "Please ask a question with at least 3 characters.");
      return;
    }

    if (question.length > 1000) {
      await errorReply(interaction, "Question Too Long", "Please keep your question under 1,000 characters.");
      return;
    }

    if (!isOpenRouterConfigured()) {
      await errorReply(
        interaction,
        "AI Explanations Unavailable",
        "OpenRouter is not configured yet. Please ask a professor to set `OPENROUTER_API_KEY` before using `/explain`.",
      );
      return;
    }

    await interaction.deferReply();

    try {
      const explanation = await generateExplanation({
        question,
        username: interaction.user.displayName,
      });

      await interaction.editReply({
        embeds: [
          {
            color: BOT_COLORS.INFO,
            title: "📚 Explanation from the Library",
            description: explanation,
            fields: [{ name: "Question", value: question.slice(0, 1024) }],
            footer: { text: "AI-generated via OpenRouter. Double-check important facts." },
          },
        ],
      });
    } catch (error) {
      log.warn("OpenRouter explanation failed", {
        userId: interaction.user.id,
        user: interaction.user.tag,
        error: error instanceof Error ? error.message : String(error),
      });
      await errorReply(
        interaction,
        "Explanation Failed",
        "The library portraits could not fetch an answer right now. Please try again later.",
        { deferred: true },
      );
    }
  },
} as Command;
