import type { GuildMember } from "discord.js";
import { hasAnyRole } from "@/discord/utils/role.ts";
import { createLogger } from "@/common/logging/logger.ts";
import { Role } from "@/common/constants.ts";

const log = createLogger("Streak");

export async function updateMessageStreakInNickname(member: GuildMember | null, newStreak: number): Promise<void> {
  // Can't update nickname of guild owner
  if (!member || member.guild.ownerId === member.user.id || hasAnyRole(member, Role.PROFESSOR)) return;

  // If member has no nickname, no need to reset
  if (newStreak === 0 && member.nickname === null) return;

  const fallbackName = member.user.globalName ?? member.user.displayName;
  const newNickname = updateNicknameStreak(member.nickname, fallbackName, newStreak);

  const ctx = { user: member.user.tag, from: member.nickname ?? "NO_NICKNAME", to: newNickname };

  if (newNickname.length > 32) {
    log.debug("Nickname too long", ctx);
    return;
  }

  if (newNickname !== member.nickname) {
    log.debug("Updating nickname", ctx);
    await member.setNickname(newNickname, `Updating message streak to ${newStreak}`);
  }
}

function updateNicknameStreak(
  currentNickname: string | null,
  fallbackName: string,
  newStreak: number,
): string {
  let newNickname =
    currentNickname?.replace(/⚡\d+(?=[^⚡]*$)/, newStreak === 0 ? "" : `⚡${newStreak}`).trim() ?? fallbackName;

  if (newStreak !== 0 && !/⚡\d+/.exec(newNickname)) {
    newNickname += ` ⚡${newStreak}`;
  }

  return newNickname.trim();
}
