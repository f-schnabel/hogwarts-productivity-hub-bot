import dayjs from "dayjs";
import type { Sums } from "@/common/types.ts";
import { calculateVoiceSessionPointsForLocalDay } from "./voiceSessionCorrection.ts";

export interface IntegrityVoiceSession {
  joinedAt: Date;
  leftAt: Date | null;
  duration: number | null;
}

interface VirtualVoiceSession {
  id: number;
  joinedAt: Date;
  leftAt: Date;
  duration: number;
  localDay: string;
}

export function calculateVoiceIntegritySums(
  sessions: IntegrityVoiceSession[],
  timezone: string,
  monthStart: Date,
  lastDailyReset: Date,
): { points: Sums; time: Sums } {
  const sessionsByLocalDay = new Map<string, VirtualVoiceSession[]>();
  let nextVirtualId = 1;

  for (const session of sessions) {
    if (session.leftAt === null || session.duration === null || session.duration <= 0) continue;

    for (const piece of splitSessionAtLocalMidnights({
      joinedAt: session.joinedAt,
      leftAt: session.leftAt,
      duration: session.duration,
    }, timezone)) {
      piece.id = nextVirtualId++;
      const dailySessions = sessionsByLocalDay.get(piece.localDay) ?? [];
      dailySessions.push(piece);
      sessionsByLocalDay.set(piece.localDay, dailySessions);
    }
  }

  const points: Sums = { total: 0, monthly: 0, daily: 0 };
  const time: Sums = { total: 0, monthly: 0, daily: 0 };
  const currentDailyKey = dayjs(lastDailyReset).tz(timezone).format("YYYY-MM-DD");

  for (const [localDay, dailySessions] of sessionsByLocalDay) {
    dailySessions.sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime());
    const calculatedPoints = new Map(
      calculateVoiceSessionPointsForLocalDay(dailySessions).map((result) => [result.id, result.points]),
    );

    for (const session of dailySessions) {
      const sessionPoints = calculatedPoints.get(session.id) ?? 0;
      points.total += sessionPoints;
      time.total += session.duration;

      if (session.leftAt >= monthStart) {
        points.monthly += sessionPoints;
        time.monthly += session.duration;
      }
      if (localDay === currentDailyKey) {
        points.daily += sessionPoints;
        time.daily += session.duration;
      }
    }
  }

  return { points, time };
}

function splitSessionAtLocalMidnights(
  session: { joinedAt: Date; leftAt: Date; duration: number },
  timezone: string,
): VirtualVoiceSession[] {
  if (session.leftAt <= session.joinedAt) return [];

  const pieces: VirtualVoiceSession[] = [];
  let cursor = session.joinedAt;
  let allocatedDuration = 0;

  while (cursor < session.leftAt) {
    const localCursor = dayjs(cursor).tz(timezone);
    const nextLocalDate = localCursor.add(1, "day").format("YYYY-MM-DD");
    const nextMidnight = dayjs.tz(nextLocalDate, timezone).startOf("day").toDate();
    const leftAt = nextMidnight < session.leftAt ? nextMidnight : session.leftAt;
    const elapsedFraction =
      (leftAt.getTime() - session.joinedAt.getTime()) /
      (session.leftAt.getTime() - session.joinedAt.getTime());
    const targetDuration = leftAt >= session.leftAt
      ? session.duration
      : Math.round(session.duration * elapsedFraction);
    const duration = targetDuration - allocatedDuration;

    if (duration > 0) {
      pieces.push({
        id: 0,
        joinedAt: cursor,
        leftAt,
        duration,
        localDay: localCursor.format("YYYY-MM-DD"),
      });
    }
    allocatedDuration = targetDuration;
    cursor = leftAt;
  }

  return pieces;
}
