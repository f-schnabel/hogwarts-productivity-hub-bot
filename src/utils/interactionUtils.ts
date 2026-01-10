import type { ChatInputCommandInteraction } from "discord.js";
import { BOT_COLORS } from "./constants.ts";
import { createLogger } from "./logger.ts";

const log = createLogger("Interaction");

export async function editReplyError(
  opId: string,
  interaction: ChatInputCommandInteraction,
  title: string,
  ...messages: string[]
) {
  log.warn("Error reply", { opId, user: interaction.user.username, title, msg: messages.join("; ") });
  await interaction.editReply({
    embeds: [
      {
        color: BOT_COLORS.ERROR,
        title: `❌ ${title}`,
        description: messages.join("\n"),
      },
    ],
  });
}

export async function replyError(
  opId: string,
  interaction: ChatInputCommandInteraction,
  title: string,
  ...messages: string[]
) {
  log.warn("Error reply", { opId, user: interaction.user.username, title, msg: messages.join("; ") });
  await interaction.reply({
    embeds: [
      {
        color: BOT_COLORS.ERROR,
        title: `❌ ${title}`,
        description: messages.join("\n"),
      },
    ],
  });
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
