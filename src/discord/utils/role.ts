import type { ChatInputCommandInteraction, GuildMember } from "discord.js";
import { Role } from "../../common/constants.ts";
import { errorReply } from "./interaction.ts";


function getPrefectRoleIds(): string[] {
  return process.env.PREFECT_ROLE_IDS.split(",").map((roleId) => roleId.trim()).filter(Boolean);
}

/** Returns true if role check passed, false if error was sent */
export function requireRole(interaction: ChatInputCommandInteraction<"cached">, roles: number): boolean {
  if (!hasAnyRole(interaction.member, roles)) {
    const roleNames: string[] = [];
    if (roles & Role.OWNER)     roleNames.push("OWNER");
    if (roles & Role.PREFECT)   roleNames.push("PREFECT");
    if (roles & Role.PROFESSOR) roleNames.push("PROFESSOR");
    void errorReply(interaction, "Insufficient Permissions", `Only ${roleNames.join(" or ")} can use this command.`);
    return false;
  }
  return true;
}

export function hasAnyRole(member: GuildMember, roles: number): boolean {
  let memberRoles = 0;
  if (member.id === process.env.OWNER_ID)                                      memberRoles |= Role.OWNER;
  if (getPrefectRoleIds().some((roleId) => member.roles.cache.has(roleId)))    memberRoles |= Role.PREFECT;
  if (member.roles.cache.has(process.env.PROFESSOR_ROLE_ID))                   memberRoles |= Role.PROFESSOR;
  return (memberRoles & roles) !== 0;
}
