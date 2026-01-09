import type { GuildMember } from "discord.js";

export const Role = {
  OWNER: 1 << 0,
  PREFECT: 1 << 1,
  PROFESSOR: 1 << 2,
} as const;

export function hasAnyRole(member: GuildMember, roles: number): boolean {
  let memberRoles = 0;
  if (member.id === process.env.OWNER_ID) memberRoles |= Role.OWNER;
  if (member.roles.cache.has(process.env.PREFECT_ROLE_ID)) memberRoles |= Role.PREFECT;
  if (member.roles.cache.has(process.env.PROFESSOR_ROLE_ID)) memberRoles |= Role.PROFESSOR;
  return (memberRoles & roles) !== 0;
}
