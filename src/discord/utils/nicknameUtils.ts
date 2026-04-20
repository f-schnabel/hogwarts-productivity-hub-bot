import type { GuildMember } from "discord.js";
import { hasAnyRole } from "./roleUtils.ts";
import { createLogger } from "../../common/logging/logger.ts";
import { Role } from "../../common/constants.ts";
import { getVCEmoji } from "../../db/db.ts";

const log = createLogger("Streak");

export async function updateMessageStreakInNickname(member: GuildMember | null, newStreak: number): Promise<void> {
  // Can't update nickname of guild owner
  if (!member || member.guild.ownerId === member.user.id || hasAnyRole(member, Role.PROFESSOR)) return;

  // If member has no nickname, no need to reset
  if (newStreak === 0 && member.nickname === null) return;

  let newNickname =
    member.nickname?.replace(/⚡\d+(?=[^⚡]*$)/, newStreak === 0 ? "" : `⚡${newStreak}`).trim() ??
    member.user.globalName ??
    member.user.displayName;

  // If no existing streak found, append it
  if (newStreak !== 0 && !/⚡\d+/.exec(newNickname)) {
    newNickname += ` ⚡${newStreak}`;
  }

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

export async function VCEmojiNeedsAdding(member: GuildMember): Promise<string | null> {
  if (hasAnyRole(member, Role.PROFESSOR)) return null;
  return VCEmojiNeedsAddingSync(member, await getVCEmoji());
}

function VCEmojiNeedsAddingSync(member: GuildMember, emoji: string): string | null {
  if (hasAnyRole(member, Role.PROFESSOR)) return null;
  if (member.nickname?.includes(" " + emoji)) return null;

  const newNickname = member.displayName + " " + emoji;
  if (newNickname.length > 32) {
    log.debug("Nickname too long to add VC emoji", { userId: member.id, username: member.user.username, newNickname });
    return null;
  }

  log.debug("Adding VC emoji to nickname", { userId: member.id, username: member.user.username, newNickname });
  return newNickname;
}

export async function VCEmojiNeedsRemoval(member: GuildMember): Promise<string | null> {
  if (hasAnyRole(member, Role.PROFESSOR)) return null;
  return VCEmojiNeedsRemovalSync(member, await getVCEmoji());
}

export function VCEmojiNeedsRemovalSync(member: GuildMember, emoji: string): string | null {
  if (hasAnyRole(member, Role.PROFESSOR)) return null;
  if (!member.nickname?.includes(" " + emoji)) return null;

  const newNickname = member.nickname
    .replaceAll(" " + emoji, "")
    .replaceAll(emoji, "")
    .trim();
  if (newNickname.length === 0) return null;
  log.debug("Removing VC emoji from nickname", { userId: member.id, username: member.user.username, newNickname });
  return newNickname;
}
