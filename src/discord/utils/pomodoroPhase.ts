import type { PomodoroStage } from "@/common/types.ts";

export interface PomodoroPhase {
  stage: PomodoroStage;
  stageStartedAt: Date;
  nextStageAt: Date;
  elapsedCycles: number;
}

const MINUTE_MS = 60_000;

export function getPomodoroPhase(
  startedAt: Date,
  focusMinutes: number,
  breakMinutes: number,
  now: Date,
): PomodoroPhase {
  const focusMs = focusMinutes * MINUTE_MS;
  const breakMs = breakMinutes * MINUTE_MS;
  const cycleMs = focusMs + breakMs;
  const elapsedMs = Math.max(0, now.getTime() - startedAt.getTime());
  const elapsedCycles = Math.floor(elapsedMs / cycleMs);
  const cycleStartedAtMs = startedAt.getTime() + elapsedCycles * cycleMs;
  const elapsedInCycleMs = elapsedMs - elapsedCycles * cycleMs;

  if (elapsedInCycleMs < focusMs) {
    return {
      stage: "FOCUS",
      stageStartedAt: new Date(cycleStartedAtMs),
      nextStageAt: new Date(cycleStartedAtMs + focusMs),
      elapsedCycles,
    };
  }

  return {
    stage: "BREAK",
    stageStartedAt: new Date(cycleStartedAtMs + focusMs),
    nextStageAt: new Date(cycleStartedAtMs + cycleMs),
    elapsedCycles,
  };
}

export function getPomodoroBreakSecondsInInterval(
  pomodoroStartedAt: Date,
  focusMinutes: number,
  breakMinutes: number,
  intervalStartedAt: Date,
  intervalEndedAt: Date,
): number {
  const intervalStartMs = intervalStartedAt.getTime();
  const intervalEndMs = intervalEndedAt.getTime();
  if (intervalEndMs <= intervalStartMs) return 0;

  const focusMs = focusMinutes * MINUTE_MS;
  const breakMs = breakMinutes * MINUTE_MS;
  const cycleMs = focusMs + breakMs;
  const pomodoroStartMs = pomodoroStartedAt.getTime();
  const firstCycle = Math.max(0, Math.floor((intervalStartMs - pomodoroStartMs) / cycleMs) - 1);
  let breakMsInInterval = 0;

  for (let cycle = firstCycle; ; cycle++) {
    const breakStartMs = pomodoroStartMs + cycle * cycleMs + focusMs;
    const breakEndMs = breakStartMs + breakMs;
    if (breakStartMs >= intervalEndMs) break;

    const overlapStartMs = Math.max(intervalStartMs, breakStartMs);
    const overlapEndMs = Math.min(intervalEndMs, breakEndMs);
    if (overlapEndMs > overlapStartMs) {
      breakMsInInterval += overlapEndMs - overlapStartMs;
    }
  }

  return Math.floor(breakMsInInterval / 1000);
}
