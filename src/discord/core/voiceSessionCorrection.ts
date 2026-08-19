import dayjs from "dayjs";
import { calculatePoints } from "./points.ts";

export interface VoiceSessionPointInput {
  id: number;
  joinedAt: Date;
  duration: number | null;
  points: number | null;
}

export interface VoiceSessionPointUpdate {
  id: number;
  points: number;
}

export function parseVoiceSessionEndTime(value: string, localDay: dayjs.Dayjs): Date | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) return null;

  const [, hour, minute] = match;
  return localDay.hour(Number(hour)).minute(Number(minute)).second(0).millisecond(0).toDate();
}

export function resolveVoiceSessionEndTime(value: string, localJoinedAt: dayjs.Dayjs): Date | null {
  const parsedEndTime = parseVoiceSessionEndTime(value, localJoinedAt.startOf("day"));
  if (!parsedEndTime) return null;

  // The command only accepts minutes, while joinedAt can include seconds.
  // Treat the same displayed minute as an explicitly excluded, zero-duration session.
  return value === localJoinedAt.format("HH:mm") ? localJoinedAt.toDate() : parsedEndTime;
}

export function calculateVoiceSessionPointUpdatesForLocalDay(
  sessions: VoiceSessionPointInput[],
): VoiceSessionPointUpdate[] {
  const calculatedPoints = calculateVoiceSessionPointsForLocalDay(sessions);
  const storedPoints = new Map(sessions.map((session) => [session.id, session.points]));
  return calculatedPoints.filter((result) => storedPoints.get(result.id) !== result.points);
}

export function calculateVoiceSessionPointsForLocalDay(
  sessions: Pick<VoiceSessionPointInput, "id" | "duration">[],
): VoiceSessionPointUpdate[] {
  let dailyVoiceTime = 0;
  const result: VoiceSessionPointUpdate[] = [];
  for (const session of sessions) {
    const oldDailyVoiceTime = dailyVoiceTime;
    dailyVoiceTime += session.duration ?? 0;
    const points = calculatePoints(oldDailyVoiceTime, dailyVoiceTime);
    result.push({
      id: session.id,
      points,
    });
  }
  return result;
}
