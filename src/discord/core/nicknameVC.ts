import { Role } from "@/common/constants.ts";
import { createLogger } from "@/common/logging/logger.ts";
import { getVCEmoji } from "@/db/db.ts";
import { hasAnyRole } from "@/discord/utils/role.ts";
import type { GuildMember } from "discord.js";


const log = createLogger("VoiceNickname");

export function addVcEmoji(displayName: string, currentNickname: string | null, emoji: string): string | null {
  if (currentNickname?.includes(" " + emoji)) return null;

  const newNickname = displayName + " " + emoji;
  return newNickname.length > 32 ? null : newNickname;
}

export function removeVcEmoji(currentNickname: string | null, emoji: string): string | null {
  if (!currentNickname?.includes(" " + emoji)) return null;

  const newNickname = currentNickname
    .replaceAll(" " + emoji, "")
    .replaceAll(emoji, "")
    .trim();

  return newNickname.length === 0 ? null : newNickname;
}

export async function VCEmojiNeedsAdding(member: GuildMember): Promise<string | null> {
  if (hasAnyRole(member, Role.PROFESSOR)) return null;
  return VCEmojiNeedsAddingSync(member, await getVCEmoji());
}

function VCEmojiNeedsAddingSync(member: GuildMember, emoji: string): string | null {
  if (hasAnyRole(member, Role.PROFESSOR)) return null;
  if (member.nickname?.includes(" " + emoji)) return null;

  const newNickname = addVcEmoji(member.displayName, member.nickname, emoji);
  if (newNickname === null) {
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
  const newNickname = removeVcEmoji(member.nickname, emoji);
  if (newNickname === null) return null;
  log.debug("Removing VC emoji from nickname", { userId: member.id, username: member.user.username, newNickname });
  return newNickname;
}
