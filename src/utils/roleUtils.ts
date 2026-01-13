import type { GuildMember } from "discord.js";
import { Role } from "./constants.ts";
import { alertOwner } from "./alerting.ts";
import { createLogger } from "./logger.ts";

const VC_ROLE_ID = process.env.VC_ROLE_ID;
const log = createLogger("RoleUtils");

export function hasAnyRole(member: GuildMember, roles: number): boolean {
  let memberRoles = 0;
  if (member.id === process.env.OWNER_ID) memberRoles |= Role.OWNER;
  if (member.roles.cache.has(process.env.PREFECT_ROLE_ID)) memberRoles |= Role.PREFECT;
  if (member.roles.cache.has(process.env.PROFESSOR_ROLE_ID)) memberRoles |= Role.PROFESSOR;
  return (memberRoles & roles) !== 0;
}

export async function addVCRole(opId: string, member: GuildMember) {
  try {
    const role = await member.guild.roles.fetch(VC_ROLE_ID);
    if (!role) {
      await alertOwner("VC role not found: " + VC_ROLE_ID, opId);
      return;
    }

    if (!member.roles.cache.has(role.id)) {
      log.debug("Adding VC role", { opId, userId: member.id, username: member.user.username });
      await member.roles.add(role, "User joined voice channel");
    } else {
      log.debug("User already has VC role", { opId, userId: member.id, username: member.user.username });
    }
  } catch (error) {
    log.warn("Failed to add VC role", { opId, userId: member.id, error });
    await alertOwner(
      "Failed to add VC role for " + member.id + ": " + (error instanceof Error ? error.message : String(error)),
      opId,
    );
  }
}

export async function removeVCRole(opId: string, member: GuildMember) {
  try {
    const role = await member.guild.roles.fetch(VC_ROLE_ID);
    if (!role) {
      await alertOwner("VC role not found: " + VC_ROLE_ID, opId);
      return;
    }

    if (member.roles.cache.has(role.id)) {
      log.debug("Removing VC role", { opId, userId: member.id, username: member.user.username });
      await member.roles.remove(role, "User left voice channel");
    } else {
      log.debug("User does not have VC role", { opId, userId: member.id, username: member.user.username });
    }
  } catch (error) {
    // Log but do not alert owner on role removal failures
    log.warn("Failed to remove VC role", { opId, userId: member.id, error });
    await alertOwner(
      "Failed to remove VC role for " + member.id + ": " + (error instanceof Error ? error.message : String(error)),
      opId,
    );
  }
}
