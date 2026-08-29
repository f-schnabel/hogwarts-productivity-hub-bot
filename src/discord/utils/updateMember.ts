import { DiscordAPIError, RESTJSONErrorCodes, type GuildMemberEditOptions } from "discord.js";
import type { UpdateMemberParams } from "@/common/types.ts";
import { createLogger } from "@/common/logging/logger.ts";

const log = createLogger("UpdateMember");

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

  try {
    return await member.edit(update);
  } catch (error) {
    // Member is gone (e.g. banned or kicked during a voice session) - nothing left to update
    if (error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownMember) {
      log.debug("Member no longer in guild, skipped update", { userId: member.id, user: member.user.username, reason });
      return;
    }
    throw error;
  }
}
