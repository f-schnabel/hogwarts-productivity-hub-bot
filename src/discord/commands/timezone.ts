import { SlashCommandBuilder, ChatInputCommandInteraction, AutocompleteInteraction } from "discord.js";
import { BOT_COLORS } from "@/common/constants.ts";
import dayjs from "dayjs";
import { db, getUserTimezone } from "@/db/db.ts";
import { userTable } from "@/db/schema.ts";
import { eq } from "drizzle-orm";
import { errorReply } from "@/discord/utils/interactionUtils.ts";
import type { Command } from "@/common/types.ts";
import { stripIndent } from "common-tags";
import { createLogger } from "@/common/logging/logger.ts";
import { rawTimeZones } from "@vvo/tzdb";

const log = createLogger("Timezone");

/**
 * Normalizes an offset string to ±HH:MM format (same as @vvo/tzdb rawFormat offsets):
 * - adds "+" if no sign is present
 * - zero-pads the hour to 2 digits
 * - appends ":00" if no minutes are present
 * e.g. "5" → "+05:00", "5:30" → "+05:30", "+5:30" → "+05:30", "+05:30" → "+05:30"
 */
export function normalizeOffset(s: string): string {
  const hasSign = s.startsWith("+") || s.startsWith("-");
  const sign = hasSign ? s.charAt(0) : "+";
  const rest = hasSign ? s.slice(1) : s;
  const colonIdx = rest.indexOf(":");
  const h = colonIdx >= 0 ? rest.slice(0, colonIdx) : rest;
  const m = colonIdx >= 0 ? rest.slice(colonIdx + 1) : "00";
  return `${sign}${h.padStart(2, "0")}:${m}`;
}

/** Returns the normalized offset if the word looks like an offset (only digits, +, -, :), else null. */
export function asOffsetQuery(word: string): string | null {
  return /^[+\-\d:]+$/.test(word) ? normalizeOffset(word) : null;
}

const TIMEZONES = rawTimeZones.map((tz) => ({
  name: tz.name,
  displayBaseName: `${tz.name} - ${tz.alternativeName}`,
  tzName: tz.name.toLowerCase(),
  aliases: tz.group.join(" ").toLowerCase(),
  altAndCities: [tz.alternativeName, ...tz.mainCities].join(" ").toLowerCase(),
  country: tz.countryName.toLowerCase(),
  abbr: tz.abbreviation.toLowerCase(),
  offset: normalizeOffset((tz.rawFormat.split(" ")[0] ?? "").toLowerCase()),
}));

export function scoreTimezones(words: string[]): { score: number; displayBaseName: string; value: string }[] {
  const scored: { score: number; displayBaseName: string; value: string }[] = [];

  for (const tz of TIMEZONES) {
    let totalScore = 0;
    for (const word of words) {
      const offsetQuery = asOffsetQuery(word);
      if (offsetQuery !== null && tz.offset.startsWith(offsetQuery)) totalScore += 6;
      else if (tz.abbr === word) totalScore += 5;
      else if (tz.tzName.includes(word)) totalScore += 4;
      else if (tz.country.includes(word)) totalScore += 3;
      else if (tz.altAndCities.includes(word)) totalScore += 2;
      else if (tz.aliases.includes(word)) totalScore += 1;
    }

    if (totalScore === 0) continue;

    scored.push({ score: totalScore, displayBaseName: tz.displayBaseName, value: tz.name });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored;
}

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
    const words = interaction.options.getFocused().toLowerCase().trim().split(/\s+/).filter(Boolean);

    if (words.length === 0) {
      await interaction.respond(
        TIMEZONES.slice(0, 25).map(({ displayBaseName, name }) => ({
          name: `${displayBaseName} (${dayjs().tz(name).format("HH:mm")})`,
          value: name,
        })),
      );
      return;
    }

    const scored = scoreTimezones(words);
    await interaction.respond(
      scored.slice(0, 25).map(({ displayBaseName, value }) => ({
        name: `${displayBaseName} (${dayjs().tz(value).format("HH:mm")})`,
        value,
      })),
    );
  },
} as Command;

export async function setTimezone(
  interaction: ChatInputCommandInteraction,
  discordId: string,
  whose = "Your",
  opts?: { deferred?: boolean },
) {
  const newTimezone = interaction.options.getString("timezone", true);
  // Validate timezone
  try {
    dayjs().tz(newTimezone);
  } catch {
    log.warn("Invalid timezone", { user: discordId, username: interaction.user.username, tz: newTimezone });
    await errorReply(
      interaction,
      "Invalid Timezone",
      stripIndent`
        The timezone \`${newTimezone}\` is not valid.
        Check [IANA timezone list](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones)`,
      opts,
    );
    return;
  }

  // Get current timezone for comparison
  const oldTimezone = await getUserTimezone(discordId);
  if (oldTimezone === newTimezone) {
    const reply = {
      embeds: [{
        color: BOT_COLORS.WARNING,
        title: "No Change Needed",
        description: `${whose} timezone is already set to \`${newTimezone}\`.`,
      }],
    };
    if (opts?.deferred) {
      await interaction.editReply(reply);
    } else {
      await interaction.reply(reply);
    }
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
      interaction,
      "Timezone Update Failed",
      `Failed to update ${whose.toLowerCase()} timezone. Please try again later.`,
      opts,
    );
    return;
  }
  const reply = {
    embeds: [{
      color: BOT_COLORS.SUCCESS,
      title: "Timezone Updated Successfully",
      fields: [{
        name: `${whose} New Local Time`,
        value: dayjs().tz(newTimezone).format("dddd, MMMM D, YYYY [at] h:mm A"),
        inline: true,
      }],
    }],
  };
  if (opts?.deferred) {
    await interaction.editReply(reply);
  } else {
    await interaction.reply(reply);
  }
}
