import type { GuildMember } from "discord.js";
import assert from "node:assert/strict";
import type { House } from "../types.ts";

export function getHouseFromMember(member: GuildMember | null): House | undefined {
  let house: House | undefined = undefined;
  if (member === null) return house;

  if (member.roles.cache.has(process.env.GRYFFINDOR_ROLE_ID)) {
    house = "Gryffindor";
  }
  if (member.roles.cache.has(process.env.SLYTHERIN_ROLE_ID)) {
    assert(
      house === undefined,
      `member ${member.user.tag} has multiple house roles: ${member.roles.cache.map((r) => r.name).join(", ")}`,
    );
    house = "Slytherin";
  }
  if (member.roles.cache.has(process.env.HUFFLEPUFF_ROLE_ID)) {
    assert(
      house === undefined,
      `member ${member.user.tag} has multiple house roles: ${member.roles.cache.map((r) => r.name).join(", ")}`,
    );
    house = "Hufflepuff";
  }
  if (member.roles.cache.has(process.env.RAVENCLAW_ROLE_ID)) {
    assert(
      house === undefined,
      `member ${member.user.tag} has multiple house roles: ${member.roles.cache.map((r) => r.name).join(", ")}`,
    );
    house = "Ravenclaw";
  }
  return house;
}
