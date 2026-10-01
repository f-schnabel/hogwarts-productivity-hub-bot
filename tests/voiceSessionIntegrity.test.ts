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
    );

    expect(result.points).toEqual({ total: 7, monthly: 7, daily: 7 });
  });
});
