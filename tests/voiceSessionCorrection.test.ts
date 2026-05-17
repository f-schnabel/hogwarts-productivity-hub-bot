import { describe, expect, it } from "vitest";
import dayjs from "dayjs";
import {
  calculateVoiceSessionPointUpdatesForLocalDay,
  parseVoiceSessionEndTime,
} from "@/discord/core/voiceSessionCorrection.ts";

describe("parseVoiceSessionEndTime", () => {
  it("parses a strict local time on the inferred local day", () => {
    const result = parseVoiceSessionEndTime("23:30", dayjs.tz("2026-05-17", "YYYY-MM-DD", "Europe/Berlin"));

    expect(result).not.toBeNull();
    expect(result?.toISOString()).toBe("2026-05-17T21:30:00.000Z");
  });

  it("rejects times that do not match HH:mm", () => {
    const localDay = dayjs.tz("2026-05-17", "YYYY-MM-DD", "Europe/Berlin");
    expect(parseVoiceSessionEndTime("2026-05-17 23:30", localDay)).toBeNull();
    expect(parseVoiceSessionEndTime("23:30:00", localDay)).toBeNull();
    expect(parseVoiceSessionEndTime("7:30", localDay)).toBeNull();
    expect(parseVoiceSessionEndTime("24:00", localDay)).toBeNull();
    expect(parseVoiceSessionEndTime("23:60", localDay)).toBeNull();
  });
});

describe("calculateVoiceSessionPointUpdatesForLocalDay", () => {
  it("recalculates voice points for the sorted sessions from SQL", () => {
    const updates = calculateVoiceSessionPointUpdatesForLocalDay(
      [
        {
          id: 1,
          joinedAt: new Date("2026-05-17T08:00:00.000Z"),
          duration: 2 * 60 * 60,
          points: 5,
        },
        {
          id: 2,
          joinedAt: new Date("2026-05-17T10:00:00.000Z"),
          duration: 60 * 60,
          points: 2,
        },
      ],
    );

    expect(updates).toEqual([
      { id: 1, points: 7 },
    ]);
  });
});
