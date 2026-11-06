import { describe, expect, it } from "vitest";
import dayjs from "dayjs";
import { getSubmissionDayBounds } from "@/discord/events/interactionCreate/submit/dayBounds.ts";

describe("submission local-day boundaries", () => {
  it.each([
    ["2026-03-29T12:00:00Z", "2026-03-28T23:00:00.000Z", "2026-03-29T22:00:00.000Z", 23],
    ["2026-10-25T12:00:00Z", "2026-10-24T22:00:00.000Z", "2026-10-25T23:00:00.000Z", 25],
    ["2026-06-12T12:00:00Z", "2026-06-11T22:00:00.000Z", "2026-06-12T22:00:00.000Z", 24],
  ])("uses actual midnight on %s", (now, start, end, hours) => {
    const { dayStart, dayEnd } = getSubmissionDayBounds("Europe/Berlin", dayjs(now));
    expect(dayStart.toISOString()).toBe(start);
    expect(dayEnd.toISOString()).toBe(end);
    expect(dayEnd.diff(dayStart, "hour")).toBe(hours);
  });
});
