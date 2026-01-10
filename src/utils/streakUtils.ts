import type { GuildMember } from "discord.js";
import { hasAnyRole } from "./roleUtils.ts";
import { createLogger } from "./logger.ts";
import { Role } from "./constants.ts";

const log = createLogger("Streak");

export async function updateMessageStreakInNickname(
  member: GuildMember | null,
  newStreak: number,
  opId: string,
): Promise<void> {
  // Can't update nickname of guild owner
  if (!member || member.guild.ownerId === member.user.id || hasAnyRole(member, Role.PROFESSOR)) return;

  // If member has no nickname, no need to reset
  if (newStreak == 0 && member.nickname === null) return;

  let newNickname =
    member.nickname?.replace(/⚡\d+(?=[^⚡]*$)/, newStreak === 0 ? "" : `⚡${newStreak}`).trim() ??
    member.user.globalName ??
    member.user.displayName;

  // If no existing streak found, append it
  if (newStreak !== 0 && !/⚡\d+/.exec(newNickname)) {
    newNickname += ` ⚡${newStreak}`;
  }

  const ctx = { opId, user: member.user.tag, from: member.nickname ?? "NO_NICKNAME", to: newNickname };

  if (newNickname.length > 32) {
    log.debug("Nickname too long", ctx);
    return;
  }

  if (newNickname !== member.nickname) {
    log.debug("Updating nickname", ctx);
    await member.setNickname(newNickname);
  }
}
