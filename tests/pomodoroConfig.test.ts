import { describe, expect, it } from "vitest";
import { parsePomodoroChannelName } from "@/discord/utils/pomodoroConfig.ts";

describe("parsePomodoroChannelName", () => {
  it("parses a valid time turner channel name", () => {
    expect(parsePomodoroChannelName("⏰ Time Turner (25/5 Pomo)")).toEqual({
      focusMinutes: 25,
      breakMinutes: 5,
    });
  });

  it("ignores non-pomodoro channel names", () => {
    expect(parsePomodoroChannelName("Study Hall")).toBeNull();
    expect(parsePomodoroChannelName(null)).toBeNull();
  });

  it("rejects zero, negative, and excessive durations", () => {
    expect(parsePomodoroChannelName("⏰ Time Turner (0/5 Pomo)")).toBeNull();
    expect(parsePomodoroChannelName("⏰ Time Turner (-25/5 Pomo)")).toBeNull();
    expect(parsePomodoroChannelName("⏰ Time Turner (999999/1 Pomo)")).toBeNull();
    expect(parsePomodoroChannelName("⏰ Time Turner (25/999999 Pomo)")).toBeNull();
  });
});
