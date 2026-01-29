/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/unbound-method */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-empty-function */
/**
 * Tests for utility functions
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import type { GuildMember } from "discord.js";

vi.mock("@/db/db.ts", () => ({
  getVCEmoji: vi.fn().mockResolvedValue("🎧"),
}));

import * as utils from "@/discord/utils/nicknameUtils.ts";

describe("updateMessageStreakInNickname", () => {
  let mockMember: GuildMember;
  let consoleDebugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleDebugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

    mockMember = {
      guild: { ownerId: "different-owner-id" },
      user: {
        id: "user-id",
        tag: "TestUser#1234",
        globalName: "TestUser",
        displayName: "TestUser",
      },
      nickname: null,
      roles: {
        cache: new Map(),
      },
      setNickname: vi.fn().mockImplementation((nickname) => (mockMember.nickname = nickname)),
    } as unknown as GuildMember;
  });
  const opId = "test-op-id";

  it("should not update if member is null", async () => {
    await utils.updateMessageStreakInNickname(null, 5, opId);
    expect(mockMember.setNickname).not.toHaveBeenCalled();
  });

  it("should not update if member is guild owner", async () => {
    mockMember.guild.ownerId = "user-id";
    await utils.updateMessageStreakInNickname(mockMember, 5, opId);
    expect(mockMember.setNickname).not.toHaveBeenCalled();
  });

  it("should not update if member is professor", async () => {
    mockMember.roles.cache.set(process.env.PROFESSOR_ROLE_ID, {} as any);
    await utils.updateMessageStreakInNickname(mockMember, 5, opId);
    expect(mockMember.setNickname).not.toHaveBeenCalled();
  });

  it("should not update if newStreak is 0 and member has no nickname", async () => {
    mockMember.nickname = null;
    await utils.updateMessageStreakInNickname(mockMember, 0, opId);
    expect(mockMember.setNickname).not.toHaveBeenCalled();
  });

  it("should warn and not update if nickname exceeds 32 chars", async () => {
    mockMember.nickname = "VeryLongNicknameThatExceeds32Characters ⚡5";
    await utils.updateMessageStreakInNickname(mockMember, 999, opId);
    expect(mockMember.setNickname).not.toHaveBeenCalled();
    expect(consoleDebugSpy).toHaveBeenCalledWith(expect.stringContaining("Nickname too long"));
  });

  it.each([
    {
      description: "reset streak when newStreak is 0",
      input: { nickname: "TestUser ⚡5", globalName: "GlobalName", displayName: "DisplayName" },
      streak: 0,
      expected: "TestUser",
    },
    {
      description: "replace existing streak in nickname",
      input: { nickname: "TestUser ⚡5", globalName: "TestUser", displayName: "TestUser" },
      streak: 10,
      expected: "TestUser ⚡10",
    },
    {
      description: "use globalName when no nickname exists",
      input: { nickname: null, globalName: "GlobalName", displayName: "DisplayName" },
      streak: 3,
      expected: "GlobalName ⚡3",
    },
    {
      description: "use displayName when no nickname or globalName exists",
      input: { nickname: null, globalName: null, displayName: "DisplayName" },
      streak: 3,
      expected: "DisplayName ⚡3",
    },
    {
      description: "append streak to nickname without existing streak",
      input: { nickname: "TestUser", globalName: "TestUser", displayName: "TestUser" },
      streak: 5,
      expected: "TestUser ⚡5",
    },
    {
      description: "handle multiple streak emojis and only replace last one",
      input: { nickname: "User⚡3 Name ⚡5", globalName: "User", displayName: "User" },
      streak: 7,
      expected: "User⚡3 Name ⚡7",
    },
    {
      description: "handle multiple streak emojis and only replace last one",
      input: { nickname: "User⚡3 Name ⚡5 123", globalName: "User", displayName: "User" },
      streak: 7,
      expected: "User⚡3 Name ⚡7 123",
    },
    {
      description: "trim whitespace from new nickname",
      input: { nickname: "TestUser ⚡5   ", globalName: "TestUser", displayName: "TestUser" },
      streak: 10,
      expected: "TestUser ⚡10",
    },

    {
      description: "Test explicit user",
      input: { nickname: "Silas ( ◡̀_◡́)ᕤ⚡7 ❄", globalName: "TestUser", displayName: "TestUser" },
      streak: 8,
      expected: "Silas ( ◡̀_◡́)ᕤ⚡8 ❄",
    },
  ])("should $description", async ({ input, streak, expected }) => {
    mockMember.nickname = input.nickname;
    mockMember.user.globalName = input.globalName;
    (mockMember.user as any).displayName = input.displayName;

    await utils.updateMessageStreakInNickname(mockMember, streak, opId);

    expect(mockMember.setNickname).toHaveBeenCalledExactlyOnceWith(expected, `Updating message streak to ${streak}`);
    expect(mockMember.nickname).toBe(expected);
  });
});

describe("VCEmojiNeedsAdding", () => {
  let mockMember: GuildMember;
  const ctx = { opId: "test-op-id" };

  beforeEach(() => {
    vi.clearAllMocks();
    mockMember = {
      displayName: "TestUser",
      nickname: null,
      roles: { cache: new Map() },
    } as unknown as GuildMember;
  });

  it("returns null if member is professor", async () => {
    mockMember.roles.cache.set(process.env.PROFESSOR_ROLE_ID, {} as any);
    const result = await utils.VCEmojiNeedsAdding(ctx, mockMember);
    expect(result).toBeNull();
  });

  it("returns null if nickname already has emoji", async () => {
    mockMember.nickname = "TestUser 🎧";
    const result = await utils.VCEmojiNeedsAdding(ctx, mockMember);
    expect(result).toBeNull();
  });

  it("returns new nickname with emoji appended", async () => {
    const result = await utils.VCEmojiNeedsAdding(ctx, mockMember);
    expect(result).toBe("TestUser 🎧");
  });

  it("returns null if new nickname would exceed 32 chars", async () => {
    (mockMember as any).displayName = "VeryLongDisplayNameThatIs30Char";
    const result = await utils.VCEmojiNeedsAdding(ctx, mockMember);
    expect(result).toBeNull();
  });
});

describe("VCEmojiNeedsRemoval", () => {
  let mockMember: GuildMember;
  const ctx = { opId: "test-op-id" };

  beforeEach(() => {
    vi.clearAllMocks();
    mockMember = {
      displayName: "TestUser",
      nickname: "TestUser 🎧",
      roles: { cache: new Map() },
    } as unknown as GuildMember;
  });

  it("returns null if member is professor", async () => {
    mockMember.roles.cache.set(process.env.PROFESSOR_ROLE_ID, {} as any);
    const result = await utils.VCEmojiNeedsRemoval(ctx, mockMember);
    expect(result).toBeNull();
  });

  it("returns null if nickname does not have emoji", async () => {
    mockMember.nickname = "TestUser";
    const result = await utils.VCEmojiNeedsRemoval(ctx, mockMember);
    expect(result).toBeNull();
  });

  it("returns nickname with emoji removed", async () => {
    const result = await utils.VCEmojiNeedsRemoval(ctx, mockMember);
    expect(result).toBe("TestUser");
  });

  it("returns null if removing emoji would result in empty string", async () => {
    mockMember.nickname = " 🎧";
    const result = await utils.VCEmojiNeedsRemoval(ctx, mockMember);
    expect(result).toBeNull();
  });

  it("removes multiple occurrences of emoji", async () => {
    mockMember.nickname = "Test 🎧 User 🎧";
    const result = await utils.VCEmojiNeedsRemoval(ctx, mockMember);
    expect(result).toBe("Test User");
  });
});
