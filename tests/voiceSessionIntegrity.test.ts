import { describe, expect, it } from "vitest";
import { calculateVoiceIntegritySums } from "@/discord/core/voiceSessionIntegrity.ts";

describe("calculateVoiceIntegritySums", () => {
  it("splits voice time and first-hour points across local midnight", () => {
    const result = calculateVoiceIntegritySums(
      [
        {
          // 23:00-01:00 in Asia/Kolkata
          joinedAt: new Date("2026-06-21T17:30:00.000Z"),
          leftAt: new Date("2026-06-21T19:30:00.000Z"),
          duration: 2 * 60 * 60,
        },
      ],
      "Asia/Kolkata",
      new Date("2026-06-01T00:00:00.000Z"),
      // The reset may be processed after midnight; the voice day still begins at exact local midnight.
      new Date("2026-06-21T18:30:12.000Z"),
      [],
    );

    expect(result.time).toEqual({ total: 7200, monthly: 7200, daily: 3600 });
    expect(result.points).toEqual({ total: 10, monthly: 10, daily: 5 });
  });

  it("uses cumulative voice time for multiple sessions on the same local day", () => {
    const result = calculateVoiceIntegritySums(
      [
        {
          joinedAt: new Date("2026-06-21T08:00:00.000Z"),
          leftAt: new Date("2026-06-21T09:00:00.000Z"),
          duration: 60 * 60,
        },
        {
          joinedAt: new Date("2026-06-21T10:00:00.000Z"),
          leftAt: new Date("2026-06-21T11:00:00.000Z"),
          duration: 60 * 60,
        },
      ],
      "UTC",
      new Date("2026-06-01T00:00:00.000Z"),
      new Date("2026-06-21T00:00:00.000Z"),
      [],
    );

    expect(result.points).toEqual({ total: 7, monthly: 7, daily: 7 });
  });
});

describe("calculateVoiceIntegritySums on the day of a monthly reset", () => {
  it("splits a session crossing the reset and only counts the part after it for the month", () => {
    const result = calculateVoiceIntegritySums(
      [
        {
          joinedAt: new Date("2026-10-01T09:00:00.000Z"),
          leftAt: new Date("2026-10-01T13:00:00.000Z"),
          duration: 4 * 60 * 60,
        },
      ],
      "UTC",
      new Date("2026-10-01T11:00:00.000Z"),
      new Date("2026-10-01T00:00:00.000Z"),
      [new Date("2026-10-01T11:00:00.000Z")],
    );

    expect(result.time).toEqual({ total: 14400, monthly: 7200, daily: 14400 });
    // Before: 5 + 2. After: 2 hours without a second first-hour bonus
    expect(result.points).toEqual({ total: 11, monthly: 4, daily: 11 });
  });

  it("keeps scoring an earlier split reset after the next reset", () => {
    const octoberReset = new Date("2026-10-01T12:00:00.000Z");
    const result = calculateVoiceIntegritySums(
      [
        {
          joinedAt: new Date("2026-10-01T10:30:00.000Z"),
          leftAt: new Date(octoberReset.getTime() - 1),
          duration: 90 * 60,
        },
        {
          joinedAt: octoberReset,
          leftAt: new Date("2026-10-01T13:30:00.000Z"),
          duration: 90 * 60,
        },
      ],
      "UTC",
      // The November reset is now the month start
      new Date("2026-11-01T12:00:00.000Z"),
      new Date("2026-11-01T00:00:00.000Z"),
      [octoberReset, new Date("2026-11-01T12:00:00.000Z")],
    );

    // 5 before the October reset + 2 after it, not 5 + 4
    expect(result.points.total).toBe(7);
  });

  it("counts a session crossing a reset that didn't split sessions fully in the new month", () => {
    const result = calculateVoiceIntegritySums(
      [
        {
          joinedAt: new Date("2026-10-01T09:00:00.000Z"),
          leftAt: new Date("2026-10-01T13:00:00.000Z"),
          duration: 4 * 60 * 60,
        },
      ],
      "UTC",
      new Date("2026-10-01T11:00:00.000Z"),
      new Date("2026-10-01T00:00:00.000Z"),
      [],
    );

    expect(result.time.monthly).toBe(4 * 60 * 60);
    expect(result.points).toEqual({ total: 11, monthly: 11, daily: 11 });
  });
});
