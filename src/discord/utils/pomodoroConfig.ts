import type { PomodoroChannelConfig } from "@/common/types.ts";

export const MAX_POMODORO_FOCUS_MINUTES = 240;
export const MAX_POMODORO_BREAK_MINUTES = 120;

const POMODORO_CHANNEL_NAME = /^⏰ Time Turner \((\d+)\/(\d+) Pomo\)/;

export function parsePomodoroChannelName(name: string | null): PomodoroChannelConfig | null {
  if (!name) return null;
  const match = POMODORO_CHANNEL_NAME.exec(name);
  if (!match) return null;

  const focusMinutes = Number.parseInt(match[1] ?? "", 10);
  const breakMinutes = Number.parseInt(match[2] ?? "", 10);

  if (
    !Number.isInteger(focusMinutes) ||
    !Number.isInteger(breakMinutes) ||
    focusMinutes <= 0 ||
    breakMinutes <= 0 ||
    focusMinutes > MAX_POMODORO_FOCUS_MINUTES ||
    breakMinutes > MAX_POMODORO_BREAK_MINUTES
  ) {
    return null;
  }

  return { focusMinutes, breakMinutes };
}
