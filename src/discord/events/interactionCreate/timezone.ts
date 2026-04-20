import { SlashCommandBuilder, ChatInputCommandInteraction, AutocompleteInteraction } from "discord.js";
import type { Command } from "@/common/types.ts";
import { autocompleteTimezone, setTimezone } from "@/discord/core/timezone.ts";

export default {
  data: new SlashCommandBuilder()
    .setName("timezone")
    .setDescription("Manage your timezone settings for accurate daily/monthly resets")
    .addStringOption((option) =>
      option
        .setName("timezone")
        .setDescription("Your timezone (e.g., America/New_York, Europe/London)")
        .setRequired(true)
        .setAutocomplete(true),
    ),

  /**
   * Set the timezone.
   *
   * Does not use deferReply as this command is expected to be quick.
   */
  async execute(interaction: ChatInputCommandInteraction) {
    await setTimezone(interaction, interaction.user.id);
  },

  async autocomplete(interaction: AutocompleteInteraction) {
    await autocompleteTimezone(interaction);
  },
} as Command;
