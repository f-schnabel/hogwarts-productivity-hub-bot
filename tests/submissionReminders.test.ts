import { describe, expect, it } from "vitest";
import dayjs from "dayjs";
import { getReminderOptions, validateReminderValue } from "@/discord/events/interactionCreate/submit/reminders.ts";

describe("submission reminder options", () => {
  it("shows future UTC reset ticks for the current local day", () => {
    const options = getReminderOptions("UTC", dayjs.utc("2026-06-12T11:20:00Z"));
    const first = options[0];
    const last = options.at(-1);

    expect(options).toHaveLength(12);
    expect(first?.label).toMatch(/^12:00 PM/);
    expect(first?.value).toBe("2026-06-12T12:00:00.000Z");
    expect(last?.label).toMatch(/^11:00 PM/);
    expect(last?.value).toBe("2026-06-12T23:00:00.000Z");
  });

  it("shows actual reset tick minutes in half-hour timezones", () => {
    const options = getReminderOptions("Asia/Kolkata", dayjs.utc("2026-06-12T11:20:00Z"));
    const first = options[0];
    const last = options.at(-1);

    expect(first?.label).toMatch(/^5:30 PM/);
    expect(first?.value).toBe("2026-06-12T12:00:00.000Z");
    expect(last?.label).toMatch(/^11:30 PM/);
    expect(last?.value).toBe("2026-06-12T18:00:00.000Z");
  });

  it("does not offer next-day reminder times", () => {
    const options = getReminderOptions("UTC", dayjs.utc("2026-06-12T23:05:00Z"));

    expect(options).toEqual([]);
  });

  it("accepts only currently available reminder values", () => {
    const now = dayjs.utc("2026-06-12T11:20:00Z");

    expect(validateReminderValue("2026-06-12T12:00:00.000Z", "UTC", now)).toEqual(new Date("2026-06-12T12:00:00.000Z"));
    expect(validateReminderValue("2026-06-12T11:00:00.000Z", "UTC", now)).toBeNull();
  });
});
