
import type { GuildMember, Role as RoleType } from "discord.js";
import { alertOwner } from "../utils/alerting.ts";
import { createLogger } from "@/common/logging/logger.ts";

const log = createLogger("Voice");
const VC_ROLE_ID = process.env.VC_ROLE_ID;

export async function VCRoleNeedsAdding(member: GuildMember): Promise<string[]> {
  const role = await member.guild.roles.fetch(VC_ROLE_ID);
  if (!role) {
    await alertOwner("VC role not found: " + VC_ROLE_ID);
    return [];
  }
  return VCRoleNeedsAddingSync(member, role);
}

function VCRoleNeedsAddingSync(member: GuildMember, role: RoleType): string[] {
  if (member.roles.cache.has(role.id)) {
    // log.debug("User already has VC role", ctx);
    return [];
  }
  log.debug("Adding VC role", { userId: member.id, username: member.user.username });
  return [role.id];
}

export async function VCRoleNeedsRemoval(member: GuildMember): Promise<string[]> {
  const role = await member.guild.roles.fetch(VC_ROLE_ID);
  if (!role) {
    await alertOwner("VC role not found: " + VC_ROLE_ID);
    return [];
  }
  return VCRoleNeedsRemovalSync(member, role);
}

export function VCRoleNeedsRemovalSync(member: GuildMember, role: RoleType) {
  if (!member.roles.cache.has(role.id)) {
    return [];
  }
  return [role.id];
}
