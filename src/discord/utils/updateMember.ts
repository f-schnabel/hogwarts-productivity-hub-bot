import type { GuildMemberEditOptions } from "discord.js";
import type { UpdateMemberParams } from "@/common/types.ts";

export async function updateMember({ member, reason, nickname, roleUpdates }: UpdateMemberParams) {
  const update: GuildMemberEditOptions = {};
  if (nickname !== null) update.nick = nickname;

  const rolesToAdd = roleUpdates?.rolesToAdd ?? [];
  const rolesToRemove = roleUpdates?.rolesToRemove ?? [];

  if (rolesToAdd.length > 0 || rolesToRemove.length > 0) {
    update.roles = [...member.roles.cache.keys().filter((roleId) => !rolesToRemove.includes(roleId)), ...rolesToAdd];
  }

  if (Object.keys(update).length === 0) return;
  if (reason) update.reason = reason;

  return member.edit(update);
}
