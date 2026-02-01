import type { GuildMember } from "discord.js";
import { hasAnyRole } from "./roleUtils.ts";
import { createLogger, type Ctx } from "../../common/logger.ts";
import { Role } from "../../common/constants.ts";
import { getVCEmoji } from "../../db/db.ts";

const log = createLogger("Streak");

export async function updateMessageStreakInNickname(
  member: GuildMember | null,
  newStreak: number,
  opId: string,
): Promise<void> {
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

  const ctx = { opId, user: member.user.tag, from: member.nickname ?? "NO_NICKNAME", to: newNickname };

  if (newNickname.length > 32) {
    log.debug("Nickname too long", ctx);
    return;
  }

  if (newNickname !== member.nickname) {
    log.debug("Updating nickname", ctx);
    await member.setNickname(newNickname, `Updating message streak to ${newStreak}`);
  }
}

export async function VCEmojiNeedsAdding(ctx: Ctx, member: GuildMember): Promise<string | null> {
  if (hasAnyRole(member, Role.PROFESSOR)) return null;
  return VCEmojiNeedsAddingSync(ctx, member, await getVCEmoji());
}

function VCEmojiNeedsAddingSync(ctx: Ctx, member: GuildMember, emoji: string): string | null {
  if (hasAnyRole(member, Role.PROFESSOR)) return null;
  if (member.nickname?.includes(" " + emoji)) return null;

  const newNickname = member.displayName + " " + emoji;
  if (newNickname.length > 32) {
    log.debug("Nickname too long to add VC emoji", { ...ctx, newNickname });
    return null;
  }

  log.debug("Adding VC emoji to nickname", { ...ctx, newNickname });
  return newNickname;
}

export async function VCEmojiNeedsRemoval(ctx: Ctx, member: GuildMember): Promise<string | null> {
  if (hasAnyRole(member, Role.PROFESSOR)) return null;
  return VCEmojiNeedsRemovalSync(ctx, member, await getVCEmoji());
}

export function VCEmojiNeedsRemovalSync(ctx: Ctx, member: GuildMember, emoji: string): string | null {
  if (hasAnyRole(member, Role.PROFESSOR)) return null;
  if (!member.nickname?.includes(" " + emoji)) return null;

  const newNickname = member.nickname
    .replaceAll(" " + emoji, "")
    .replaceAll(emoji, "")
    .trim();
  if (newNickname.length === 0) return null;

  log.debug("Removing VC emoji from nickname", { ...ctx, newNickname });
  return newNickname;
}
