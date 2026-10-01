import { describe, expect, it } from "vitest";
import { calculatePoints, calculatePointsHelper, getUncountedVoiceTime } from "@/discord/core/points.ts";
import { FIRST_HOUR_POINTS, MAX_HOURS_PER_DAY, REST_HOURS_POINTS } from "@/common/constants.ts";

describe("Calculate Points Tests", () => {
  it("should calculate points correctly based on voice time", () => {
    const oldDailyVoiceTime = 300; // 5 minutes
    const newDailyVoiceTime = 3600; // 1 hour

    const points = calculatePoints(oldDailyVoiceTime, newDailyVoiceTime);
    expect(points).toBe(FIRST_HOUR_POINTS);
  });

  it("should return zero points if no significant change", () => {
    const oldDailyVoiceTime = 3500; // 58 minutes
    const newDailyVoiceTime = 3600; // 1 hour

    const points = calculatePoints(oldDailyVoiceTime, newDailyVoiceTime);
    expect(points).toBe(0); // No points awarded for just reaching an hour without a significant increase
  });

  it("should award points for multiple hours", () => {
    const oldDailyVoiceTime = 3600; // 1 hour
    const newDailyVoiceTime = 10800; // 3 hours

    const points = calculatePoints(oldDailyVoiceTime, newDailyVoiceTime);
    const expectedPoints = REST_HOURS_POINTS * 2;
    expect(points).toBe(expectedPoints);
  });
  it("should award points for multiple hours", () => {
    const oldDailyVoiceTime = 10800; // 3 hour
    const newDailyVoiceTime = 10800 + 60 * 60; // 4 hours

    const points = calculatePoints(oldDailyVoiceTime, newDailyVoiceTime);
    const expectedPoints = REST_HOURS_POINTS * 1;
    expect(points).toBe(expectedPoints);
  });
  it("should award points for multiple hours", () => {
    const oldDailyVoiceTime = 10800; // 3 hour
    const newDailyVoiceTime = 10900; // 4 hours

    const points = calculatePoints(oldDailyVoiceTime, newDailyVoiceTime);
    expect(points).toBe(0);
  });
  it("should calculate the correct amount of points", () => {
    for (let i = 0; i <= 24; i++) {
      const result = calculatePointsHelper(i * 60 * 60);

      if (i === 0) {
        expect(result, i.toString()).toBe(0);
      } else if (i === 1) {
        expect(result, i.toString()).toBe(FIRST_HOUR_POINTS);
      } else if (i > 1 && i <= MAX_HOURS_PER_DAY) {
        expect(result, i.toString()).toBe(FIRST_HOUR_POINTS + REST_HOURS_POINTS * (i - 1));
      } else {
        expect(result, i.toString()).toBe(FIRST_HOUR_POINTS + REST_HOURS_POINTS * (MAX_HOURS_PER_DAY - 1));
      }
    }
  });

  describe("with voice time before a monthly reset", () => {
    it("only counts hours after the reset", () => {
      // 1.5h before the reset, 1h44m after it: one hour after the reset
      expect(calculatePoints(90 * 60, 90 * 60 + 104 * 60, 90 * 60)).toBe(REST_HOURS_POINTS);
    });

    it("gives the first-hour bonus if it wasn't earned before the reset", () => {
      expect(calculatePoints(30 * 60, 30 * 60 + 60 * 60, 30 * 60)).toBe(FIRST_HOUR_POINTS);
    });

    it("does not give the first-hour bonus twice", () => {
      expect(calculatePointsHelper(2 * 60 * 60, 60 * 60)).toBe(REST_HOURS_POINTS);
    });

    it("caps hours before and after the reset together", () => {
      expect(calculatePointsHelper(20 * 60 * 60, 10 * 60 * 60)).toBe(REST_HOURS_POINTS * (MAX_HOURS_PER_DAY - 10));
    });
  });

  describe("getUncountedVoiceTime", () => {
    it("returns the time after the last counted hour", () => {
      expect(getUncountedVoiceTime(90 * 60)).toBe(30 * 60);
      expect(getUncountedVoiceTime(30 * 60)).toBe(30 * 60);
    });

    it("returns 0 when the grace period completed the hour", () => {
      expect(getUncountedVoiceTime(56 * 60)).toBe(0);
    });
  });
});
