import type { ChatInputCommandInteraction } from "discord.js";
import { BOT_COLORS, Role } from "./constants.ts";
import { createLogger } from "./logger.ts";
import { hasAnyRole } from "./roleUtils.ts";

const log = createLogger("Interaction");

export async function errorReply(
  opId: string,
  interaction: ChatInputCommandInteraction,
  title: string,
  description: string,
  opts?: { deferred?: boolean },
) {
  log.warn("Error reply", { opId, user: interaction.user.username, title, description });
  const payload = {
    embeds: [{ color: BOT_COLORS.ERROR, title: `❌ ${title}`, description }],
  };
  if (opts?.deferred) {
    await interaction.editReply(payload);
  } else {
    await interaction.reply(payload);
  }
}

/** Returns true if role check passed, false if error was sent */
export async function requireRole(
  interaction: ChatInputCommandInteraction<"cached">,
  opId: string,
  roles: number,
): Promise<boolean> {
  if (!hasAnyRole(interaction.member, roles)) {
    const roleNames: string[] = [];
    if (roles & Role.OWNER) roleNames.push("OWNER");
    if (roles & Role.PREFECT) roleNames.push("PREFECT");
    if (roles & Role.PROFESSOR) roleNames.push("PROFESSOR");
    await errorReply(
      opId,
      interaction,
      "Insufficient Permissions",
      `Only ${roleNames.join(" or ")} can use this command.`,
    );
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
