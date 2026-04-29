import { describe, expect, it } from "vitest";
import { getPomodoroBreakSecondsInInterval, getPomodoroPhase } from "@/discord/utils/pomodoroPhase.ts";

const startedAt = new Date("2026-04-29T10:00:00.000Z");

function minutesAfterStart(minutes: number) {
  return new Date(startedAt.getTime() + minutes * 60_000);
}

describe("getPomodoroPhase", () => {
  it.each([
    [0, "FOCUS", 0, 25, 0],
    [24, "FOCUS", 0, 25, 0],
    [25, "BREAK", 25, 30, 0],
    [30, "FOCUS", 30, 55, 1],
    [55, "BREAK", 55, 60, 1],
    [60, "FOCUS", 60, 85, 2],
  ] as const)(
    "derives the phase after %i minutes",
    (elapsedMinutes, stage, stageStartedMinutes, nextStageMinutes, elapsedCycles) => {
      expect(getPomodoroPhase(startedAt, 25, 5, minutesAfterStart(elapsedMinutes))).toEqual({
        stage,
        stageStartedAt: minutesAfterStart(stageStartedMinutes),
        nextStageAt: minutesAfterStart(nextStageMinutes),
        elapsedCycles,
      });
    },
  );

  it("treats times before the session start as the initial focus phase", () => {
    expect(getPomodoroPhase(startedAt, 25, 5, new Date("2026-04-29T09:59:00.000Z"))).toEqual({
      stage: "FOCUS",
      stageStartedAt: startedAt,
      nextStageAt: minutesAfterStart(25),
      elapsedCycles: 0,
    });
  });

  it("calculates break seconds inside a real voice interval", () => {
    expect(getPomodoroBreakSecondsInInterval(startedAt, 25, 5, minutesAfterStart(20), minutesAfterStart(35))).toBe(300);
    expect(getPomodoroBreakSecondsInInterval(startedAt, 25, 5, minutesAfterStart(20), minutesAfterStart(65))).toBe(600);
    expect(getPomodoroBreakSecondsInInterval(startedAt, 25, 5, minutesAfterStart(0), minutesAfterStart(24))).toBe(0);
  });
});
