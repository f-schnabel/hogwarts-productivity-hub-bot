import dayjs from "dayjs";
import { calculatePoints } from "./points.ts";

export interface VoiceSessionPointInput {
  id: number;
  joinedAt: Date;
  leftAt: Date | null;
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
  splitResetTimes: Date[],
): VoiceSessionPointUpdate[] {
  const calculatedPoints = calculateVoiceSessionPointsForLocalDay(sessions, splitResetTimes);
  const storedPoints = new Map(sessions.map((session) => [session.id, session.points]));
  return calculatedPoints.filter((result) => storedPoints.get(result.id) !== result.points);
}

/**
 * Points per session for one local day, sessions ordered by joinedAt.
 * If one of `splitResetTimes` (monthly resets that split sessions) falls in the day, sessions ending at or before it
 * belong to the old month; their time is passed as pre-reset voice time for the sessions after it
 * (see calculatePointsHelper).
 */
export function calculateVoiceSessionPointsForLocalDay(
  sessions: Pick<VoiceSessionPointInput, "id" | "joinedAt" | "leftAt" | "duration">[],
  splitResetTimes: Date[],
): VoiceSessionPointUpdate[] {
  const reset = splitResetTimes.find(
    (time) =>
      sessions.some((session) => session.leftAt !== null && session.leftAt <= time) &&
      sessions.some((session) => session.joinedAt >= time),
  );

  let dailyVoiceTime = 0;
  let preResetVoiceTime = 0;
  const result: VoiceSessionPointUpdate[] = [];
  for (const session of sessions) {
    const beforeReset = reset !== undefined && session.leftAt !== null && session.leftAt <= reset;
    const oldDailyVoiceTime = dailyVoiceTime;
    dailyVoiceTime += session.duration ?? 0;
    const points = beforeReset
      ? calculatePoints(oldDailyVoiceTime, dailyVoiceTime)
      : calculatePoints(oldDailyVoiceTime, dailyVoiceTime, preResetVoiceTime);
    if (beforeReset) preResetVoiceTime = dailyVoiceTime;
    result.push({
      id: session.id,
      points,
    });
  }
  return result;
}
