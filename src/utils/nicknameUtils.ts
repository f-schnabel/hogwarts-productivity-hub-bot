import type { GuildMember } from "discord.js";
import { hasAnyRole } from "./roleUtils.ts";
import { createLogger } from "./logger.ts";
import { Role } from "./constants.ts";
import { getVCEmoji } from "../db/db.ts";
import { alertOwner } from "./alerting.ts";

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
    await member.setNickname(newNickname, `Updating message streak to ${newStreak}`);
  }
}

export async function addVCEmoji(opId: string, member: GuildMember): Promise<string | null> {
  if (hasAnyRole(member, Role.PROFESSOR)) return null;
  const emoji = await getVCEmoji();
  try {
    if (member.nickname?.includes(" " + emoji)) return null;

    const newNickname = member.displayName + " " + emoji;
    if (newNickname.length > 32) {
      log.debug("Nickname too long to add VC emoji", { opId, username: member.user.username, newNickname });
      return null;
    }
    log.debug("Adding VC emoji to nickname", { opId, username: member.user.username, newNickname });
    return newNickname;
  } catch (error) {
    log.warn("Failed to add VC emoji", { opId, userId: member.id, error });
    await alertOwner(
      "Failed to add VC emoji for " + member.id + ": " + (error instanceof Error ? error.message : String(error)),
      opId,
    );
    return null;
  }
}

export async function removeVCEmoji(opId: string, member: GuildMember): Promise<string | null> {
  if (hasAnyRole(member, Role.PROFESSOR)) return null;
  try {
    const emoji = await getVCEmoji();
    if (!member.nickname?.includes(" " + emoji)) return null;

    const newNickname = member.nickname.replaceAll(" " + emoji, "");
    if (newNickname.length === 0) return null;
    log.debug("Removing VC emoji from nickname", { opId, username: member.user.username, newNickname });
    return newNickname;
  } catch (error) {
    log.warn("Failed to remove VC emoji", { opId, userId: member.id, error });
    await alertOwner(
      "Failed to remove VC emoji for " + member.id + ": " + (error instanceof Error ? error.message : String(error)),
      opId,
    );
    return null;
  }
}
