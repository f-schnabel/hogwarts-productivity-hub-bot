import type { GuildMember } from "discord.js";
import { beforeEach, describe, expect, it } from "vitest";
import { Role } from "@/common/constants.ts";
import { hasAnyRole } from "@/discord/utils/role.ts";

function mockMember(roleIds: string[]): GuildMember {
  return {
    id: "member-id",
    roles: {
      cache: new Map(roleIds.map((roleId) => [roleId, {}])),
    },
  } as unknown as GuildMember;
}

describe("hasAnyRole", () => {
  beforeEach(() => {
    process.env.OWNER_ID = "owner-id";
    process.env.PREFECT_ROLE_IDS = "prefect-a,prefect-b";
    process.env.PROFESSOR_ROLE_ID = "professor-id";
  });

  it("counts a member as prefect when they have any configured prefect role", () => {
    expect(hasAnyRole(mockMember(["prefect-b"]), Role.PREFECT)).toBe(true);
  });

  it("ignores blank entries and whitespace in prefect role ids", () => {
    process.env.PREFECT_ROLE_IDS = " prefect-a, ,prefect-b ";

    expect(hasAnyRole(mockMember(["prefect-a"]), Role.PREFECT)).toBe(true);
  });

  it("does not count a member as prefect when none of their roles are configured", () => {
    expect(hasAnyRole(mockMember(["other-role"]), Role.PREFECT)).toBe(false);
  });
});
