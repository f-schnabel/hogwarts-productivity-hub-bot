import type { GuildMember, Role as RoleType } from "discord.js";
import { Role } from "../../common/constants.ts";
import { alertOwner } from "./alerting.ts";
import { createLogger } from "../../common/logging/logger.ts";

const VC_ROLE_ID = process.env.VC_ROLE_ID;
const log = createLogger("RoleUtils");

export function hasAnyRole(member: GuildMember, roles: number): boolean {
  let memberRoles = 0;
  if (member.id === process.env.OWNER_ID) memberRoles |= Role.OWNER;
  if (member.roles.cache.has(process.env.PREFECT_ROLE_ID)) memberRoles |= Role.PREFECT;
  if (member.roles.cache.has(process.env.PROFESSOR_ROLE_ID)) memberRoles |= Role.PROFESSOR;
  return (memberRoles & roles) !== 0;
}

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
