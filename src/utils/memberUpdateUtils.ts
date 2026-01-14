import type { GuildMember } from "discord.js";
import { createLogger } from "./logger.ts";

const log = createLogger("MemberUpdate");

export interface MemberUpdateBatch {
  nickname?: string | null;
  rolesToAdd: string[];
  rolesToRemove: string[];
}

/**
 * Apply multiple member updates (nickname, roles) in a single API call
 */
export async function applyMemberUpdates(
  member: GuildMember,
  updates: MemberUpdateBatch,
  reason: string,
  opId: string,
): Promise<void> {
  const ctx = { opId, userId: member.id, username: member.user.username };

  // If no updates needed, return early
  if (updates.nickname === undefined && updates.rolesToAdd.length === 0 && updates.rolesToRemove.length === 0) {
    log.debug("No member updates needed", ctx);
    return;
  }

  // Build the roles array for the edit
  const currentRoles = Array.from(member.roles.cache.keys());
  let newRoles = currentRoles.filter((roleId) => !updates.rolesToRemove.includes(roleId));
  newRoles = [...new Set([...newRoles, ...updates.rolesToAdd])]; // Add new roles and deduplicate

  // Only update if something changed
  const rolesChanged = newRoles.length !== currentRoles.length || !newRoles.every((r) => currentRoles.includes(r));
  const nicknameChanged = updates.nickname !== undefined && updates.nickname !== member.nickname;

  if (!rolesChanged && !nicknameChanged) {
    log.debug("No actual changes needed", ctx);
    return;
  }

  log.debug("Applying batched member updates", {
    ...ctx,
    nickname: updates.nickname,
    addRoles: updates.rolesToAdd.length,
    removeRoles: updates.rolesToRemove.length,
  });

  try {
    await member.edit({
      ...(nicknameChanged && { nick: updates.nickname }),
      ...(rolesChanged && { roles: newRoles }),
      reason,
    });
    log.info("Member updated successfully", ctx);
  } catch (error) {
    log.error("Failed to update member", { ...ctx, error });
    throw error;
  }
}
