import { SlashCommandBuilder, ChatInputCommandInteraction, AutocompleteInteraction } from "discord.js";
import { BOT_COLORS } from "@/common/constants.ts";
import dayjs from "dayjs";
import { db, getUserTimezone } from "@/db/db.ts";
import { userTable } from "@/db/schema.ts";
import { eq } from "drizzle-orm";
import { errorReply } from "@/discord/utils/interactionUtils.ts";
import type { CommandOptions } from "@/common/types.ts";
import { getTimeZones } from "@vvo/tzdb";

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
    const query = interaction.options.getFocused().toLowerCase();
    const results = [];
    for (const tz of getTimeZones()) {
      const searchable = [tz.name, tz.alternativeName, tz.countryName, ...tz.group, ...tz.mainCities]
        .join(" ")
        .toLowerCase();
      if (searchable.includes(query)) {
        results.push({
          name: `${tz.name} - ${tz.alternativeName} (${dayjs().tz(tz.name).format("HH:mm")})`,
          value: tz.name,
        });
      }
      if (results.length >= 25) break;
    }
    await interaction.respond(results);
  },
};

async function viewTimezone(interaction: ChatInputCommandInteraction, discordId: string) {
  const userTimezone = await getUserTimezone(discordId);
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
  // Get current timezone for comparison
  const oldTimezone = await getUserTimezone(discordId);
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
