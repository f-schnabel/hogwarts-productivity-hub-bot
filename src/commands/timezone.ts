import { SlashCommandBuilder, ChatInputCommandInteraction, AutocompleteInteraction } from "discord.js";
import { BOT_COLORS } from "../utils/constants.ts";
import dayjs from "dayjs";
import { db, fetchUserTimezone } from "../db/db.ts";
import { userTable } from "../db/schema.ts";
import { eq } from "drizzle-orm";
import { errorReply } from "../utils/interactionUtils.ts";
import type { CommandOptions } from "../types.ts";
import { stripIndent } from "common-tags";
import { createLogger } from "../utils/logger.ts";

const log = createLogger("Timezone");

export default {
  data: new SlashCommandBuilder()
    .setName("timezone")
    .setDescription("Manage your timezone settings for accurate daily/monthly resets")
    .addStringOption((option) =>
      option
        .setName("timezone")
        .setDescription("Your timezone (e.g., America/New_York, Europe/London)")
        .setAutocomplete(true),
    ),

  /**
   * View or set your timezone.
   *
   * Does not use deferReply as this command is expected to be quick.
   */
  async execute(interaction: ChatInputCommandInteraction, { opId }: CommandOptions) {
    const newTimezone = interaction.options.getString("timezone");

    if (newTimezone) {
      await setTimezone(interaction, interaction.user.id, newTimezone, opId);
    } else {
      await viewTimezone(interaction, interaction.user.id);
    }
  },

  async autocomplete(interaction: AutocompleteInteraction) {
    const timezones = [];
    const query = interaction.options.getFocused().toLowerCase();
    for (const timeZone of Intl.supportedValuesOf("timeZone")) {
      if (timeZone.toLowerCase().includes(query)) {
        timezones.push({
          name: `${timeZone} (Currently ${dayjs().tz(timeZone).format("HH:mm")})`,
          value: timeZone,
        });
      }
      if (timezones.length >= 25) break;
    }
    await interaction.respond(timezones);
  },
};

async function viewTimezone(interaction: ChatInputCommandInteraction, discordId: string) {
  const userTimezone = await fetchUserTimezone(discordId);
  const userLocalTime = dayjs().tz(userTimezone).format("HH:mm");

  await interaction.reply({
    embeds: [
      {
        color: BOT_COLORS.SUCCESS,
        description: `Your timezone is currently set to \`${userTimezone}\` (Currently ${userLocalTime})`,
      },
    ],
  });
}

async function setTimezone(
  interaction: ChatInputCommandInteraction,
  discordId: string,
  newTimezone: string,
  opId: string,
) {
  // Validate timezone
  try {
    dayjs().tz(newTimezone);
  } catch {
    log.warn("Invalid timezone", { opId, user: discordId, username: interaction.user.username, tz: newTimezone });
    await errorReply(
      opId,
      interaction,
      "Invalid Timezone",
      stripIndent`
      The timezone \`${newTimezone}\` is not valid.
      Check [IANA timezone list](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones)`,
    );
    return;
  }

  // Get current timezone for comparison
  const oldTimezone = await fetchUserTimezone(discordId);
  if (oldTimezone === newTimezone) {
    await interaction.reply({
      embeds: [
        {
          color: BOT_COLORS.WARNING,
          title: `No Change Needed`,
          description: `Your timezone is already set to \`${newTimezone}\`.`,
        },
      ],
    });
    return;
  }

  // Update timezone in database
  const result = await db
    .update(userTable)
    .set({
      timezone: newTimezone,
    })
    .where(eq(userTable.discordId, discordId));

  if (result.rowCount === 0) {
    await errorReply(
      opId,
      interaction,
      "Timezone Update Failed",
      "Failed to update your timezone. Please try again later.",
    );
    return;
  }

  await interaction.reply({
    embeds: [
      {
        color: BOT_COLORS.SUCCESS,
        title: `Timezone Updated Successfully`,
        fields: [
          {
            name: "Your New Local Time",
            value: dayjs().tz(newTimezone).format("dddd, MMMM D, YYYY [at] h:mm A"),
            inline: true,
          },
        ],
      },
    ],
  });
}
