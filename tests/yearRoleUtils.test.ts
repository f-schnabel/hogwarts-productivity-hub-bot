import { describe, expect, it, vi, beforeEach } from "vitest";
import type { GuildMember } from "discord.js";

// Set env before importing module
process.env.YEAR_ROLE_IDS = "year1,year2,year3,year4,year5,year6,year7";

const { getYearFromMonthlyVoiceTime, calculateYearRoles } = await import("@/discord/utils/yearRoleUtils.ts");

describe("getYearFromMonthlyVoiceTime", () => {
  // Thresholds: 1, 10, 20, 40, 80, 100, 120 hours
  it.each([
    { seconds: 0, expected: null },
    { seconds: 30 * 60, expected: null }, // 30 min
    { seconds: 59 * 60, expected: null }, // 59 min
    { seconds: 1 * 3600, expected: 1 }, // 1 hour exactly
    { seconds: 1.5 * 3600, expected: 1 }, // 1.5 hours
    { seconds: 9 * 3600, expected: 1 }, // 9 hours
    { seconds: 10 * 3600, expected: 2 }, // 10 hours exactly
    { seconds: 15 * 3600, expected: 2 }, // 15 hours
    { seconds: 20 * 3600, expected: 3 }, // 20 hours exactly
    { seconds: 39 * 3600, expected: 3 }, // 39 hours
    { seconds: 40 * 3600, expected: 4 }, // 40 hours exactly
    { seconds: 79 * 3600, expected: 4 }, // 79 hours
    { seconds: 80 * 3600, expected: 5 }, // 80 hours exactly
    { seconds: 99 * 3600, expected: 5 }, // 99 hours
    { seconds: 100 * 3600, expected: 6 }, // 100 hours exactly
    { seconds: 119 * 3600, expected: 6 }, // 119 hours
    { seconds: 120 * 3600, expected: 7 }, // 120 hours exactly
    { seconds: 500 * 3600, expected: 7 }, // 500 hours
  ])("returns $expected for $seconds seconds", ({ seconds, expected }) => {
    expect(getYearFromMonthlyVoiceTime(seconds)).toBe(expected);
  });
});

describe("calculateYearRoles", () => {
  let mockMember: GuildMember;

  beforeEach(() => {
    vi.clearAllMocks();
    mockMember = {
      roles: {
        cache: new Map(),
      },
    } as unknown as GuildMember;
  });

  it("returns null if user is null", () => {
    expect(calculateYearRoles(mockMember, null)).toBeNull();
  });

  it("returns null if user has no house", () => {
    expect(calculateYearRoles(mockMember, { monthlyVoiceTime: 3600, house: null })).toBeNull();
  });

  it("returns empty arrays when user has no voice time and no existing roles", () => {
    const result = calculateYearRoles(mockMember, { monthlyVoiceTime: 0, house: "Gryffindor" });
    expect(result).toEqual({ rolesToRemove: [], rolesToAdd: [] });
  });

  it("adds year 1 role when user reaches 1 hour", () => {
    const result = calculateYearRoles(mockMember, { monthlyVoiceTime: 3600, house: "Gryffindor" });
    expect(result).toEqual({ rolesToRemove: [], rolesToAdd: ["year1"] });
  });

  it("does not add role if user already has it", () => {
    mockMember.roles.cache.set("year1", {} as never);
    const result = calculateYearRoles(mockMember, { monthlyVoiceTime: 3600, house: "Gryffindor" });
    expect(result).toEqual({ rolesToRemove: [], rolesToAdd: [] });
  });

  it("removes old year role when promoting to new year", () => {
    mockMember.roles.cache.set("year1", {} as never);
    const result = calculateYearRoles(mockMember, { monthlyVoiceTime: 10 * 3600, house: "Slytherin" });
    expect(result).toEqual({ rolesToRemove: ["year1"], rolesToAdd: ["year2"] });
  });

  it("removes multiple old year roles when promoting", () => {
    mockMember.roles.cache.set("year1", {} as never);
    mockMember.roles.cache.set("year2", {} as never);
    mockMember.roles.cache.set("year3", {} as never);
    const result = calculateYearRoles(mockMember, { monthlyVoiceTime: 120 * 3600, house: "Hufflepuff" });
    expect(result).toEqual({
      rolesToRemove: ["year1", "year2", "year3"],
      rolesToAdd: ["year7"],
    });
  });

  it("handles year 7 (max year) correctly", () => {
    mockMember.roles.cache.set("year6", {} as never);
    const result = calculateYearRoles(mockMember, { monthlyVoiceTime: 200 * 3600, house: "Ravenclaw" });
    expect(result).toEqual({ rolesToRemove: ["year6"], rolesToAdd: ["year7"] });
  });
});
