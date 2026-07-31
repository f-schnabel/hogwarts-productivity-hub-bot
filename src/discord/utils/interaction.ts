import type { ChatInputCommandInteraction, InteractionEditReplyOptions, InteractionReplyOptions } from "discord.js";
import { BOT_COLORS } from "../../common/constants.ts";
import { createLogger } from "../../common/logging/logger.ts";

const log = createLogger("Interaction");

export async function errorReply(
  interaction: ChatInputCommandInteraction,
  title: string,
  description: string,
  opts?: { deferred?: boolean },
) {
  log.warn("Error reply", { user: interaction.user.username, title, description });
  const payload = {
    embeds: [{ color: BOT_COLORS.ERROR, title: `❌ ${title}`, description }],
  };
  if (opts?.deferred) {
    await interaction.editReply(payload);
  } else {
    await interaction.reply(payload);
  }
}

export function reply(interaction: ChatInputCommandInteraction, reply: InteractionReplyOptions & InteractionEditReplyOptions, opts?: { deferred?: boolean }) {
  if (opts?.deferred) {
    return interaction.editReply(reply);
  }
  return interaction.reply(reply);
}

/** Sync type guard for guild check. Fires error reply if not in guild. */
export function inGuild(
  interaction: ChatInputCommandInteraction,
): interaction is ChatInputCommandInteraction<"cached"> {
  if (!interaction.inCachedGuild()) {
    void errorReply(interaction, "Invalid Context", "This command can only be used in a server.");
    return false;
  }
  return true;
}

export function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  const parts = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}min`);
  if (secs > 0 || parts.length === 0) parts.push(`${secs}sec`);
  return parts.join(" ");
}

/** Split newline-delimited text without exceeding a Discord message component's character limit. */
export function splitLinesByLength(lines: string[], maxLength: number): string[] {
  if (maxLength < 1) throw new RangeError("maxLength must be at least 1");

  const chunks: string[] = [];
  let current = "";

  for (const line of lines) {
    const lineParts = line.length > maxLength ? line.match(new RegExp(`.{1,${maxLength}}`, "gs")) ?? [""] : [line];

    for (const linePart of lineParts) {
      if (!current) {
        current = linePart;
      } else if (current.length + 1 + linePart.length <= maxLength) {
        current += `\n${linePart}`;
      } else {
        chunks.push(current);
        current = linePart;
      }
    }
  }

  if (current || chunks.length === 0) chunks.push(current);
  return chunks;
}
