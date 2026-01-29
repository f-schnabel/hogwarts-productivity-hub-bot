import type { GuildMember } from "discord.js";
import assert from "node:assert/strict";
import type { House } from "@/common/types.ts";

// Simplified version
const HOUSE_ROLES = [
  [process.env.GRYFFINDOR_ROLE_ID, "Gryffindor"],
  [process.env.SLYTHERIN_ROLE_ID, "Slytherin"],
  [process.env.HUFFLEPUFF_ROLE_ID, "Hufflepuff"],
  [process.env.RAVENCLAW_ROLE_ID, "Ravenclaw"],
] as const;

export function getHouseFromMember(member: GuildMember | null): House | undefined {
  if (!member) return undefined;
  const roles = member.roles.cache;

  const houses = HOUSE_ROLES.filter(([roleId]) => roles.has(roleId));
  assert(
    houses.length <= 1,
    `Member ${member.user.tag} has multiple house roles: ${houses.map(([, name]) => name).join(", ")}`,
  );
  return houses[0]?.[1];
}
