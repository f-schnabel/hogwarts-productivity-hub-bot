import { time, userMention } from "discord.js";
import type { PomodoroStage } from "@/common/types.ts";

export interface PomodoroStatus {
  focusMinutes: number;
  breakMinutes: number;
  stage: PomodoroStage;
  nextStageAt: Date;
}

export function buildPomodoroStatusContent(
  session: PomodoroStatus,
  participantIds: string[],
  options: { ended: boolean; channelName: string },
): string {
  const cycle = `Cycle: ${session.focusMinutes}/${session.breakMinutes} Pomo`;
  const participants = participantIds.map((id) => userMention(id)).join(" ") || "_Nobody is in the voice channel._";

  if (options.ended) {
    return [
      `## ⏰ Pomodoro ended${options.channelName ? ` in **${options.channelName}**` : ""}`,
      cycle,
      `Participants: ${participants}`,
    ].join("\n");
  }

  const nextLabel = session.stage === "FOCUS" ? "Break starts" : "Focus resumes";
  return [
    `## ⏰ **${session.stage}**`,
    cycle,
    `${nextLabel} ${time(session.nextStageAt, "R")}`,
    `Participants: ${participants}`,
  ].join("\n");
}
