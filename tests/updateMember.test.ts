import type { GuildMember } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { updateMember } from "@/discord/utils/updateMember.ts";

const roleUpdates = { rolesToAdd: ["new-role"], rolesToRemove: ["old-role"] };

function mockMember(pending: boolean) {
  const edit = vi.fn();
  const member = {
    pending,
    edit,
    roles: { cache: new Map([["old-role", {}], ["other-role", {}]]) },
  } as unknown as GuildMember;
  return { member, edit };
}

describe("updateMember", () => {
  it("skips role-only edits while Rules Screening is pending", async () => {
    const { member, edit } = mockMember(true);

    await updateMember({ member, reason: "Refreshing year roles", roleUpdates });

    expect(edit).not.toHaveBeenCalled();
  });

  it("still updates the nickname while Rules Screening is pending", async () => {
    const { member, edit } = mockMember(true);

    await updateMember({ member, nickname: "New nickname", roleUpdates });

    expect(edit).toHaveBeenCalledExactlyOnceWith({ nick: "New nickname" });
  });

  it("applies role changes after Rules Screening is complete", async () => {
    const { member, edit } = mockMember(false);

    await updateMember({ member, roleUpdates });

    expect(edit).toHaveBeenCalledExactlyOnceWith({ roles: ["other-role", "new-role"] });
  });
});
