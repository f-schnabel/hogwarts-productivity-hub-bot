import { and, eq, gt, isNull, lt, or } from "drizzle-orm";
import { pomodoroSessionTable } from "@/db/schema.ts";
import type { DbOrTx } from "@/db/db.ts";
import { getPomodoroBreakSecondsInInterval } from "@/discord/utils/pomodoroPhase.ts";

export async function calculateCreditedVoiceSeconds(
  db: DbOrTx,
  channelId: string,
  joinedAt: Date,
  leftAt: Date,
): Promise<number> {
  const totalSeconds = Math.max(0, Math.floor((leftAt.getTime() - joinedAt.getTime()) / 1000));
  const pomodoroSessions = await db
    .select({
      startedAt: pomodoroSessionTable.startedAt,
      endedAt: pomodoroSessionTable.endedAt,
      focusMinutes: pomodoroSessionTable.focusMinutes,
      breakMinutes: pomodoroSessionTable.breakMinutes,
    })
    .from(pomodoroSessionTable)
    .where(
      and(
        eq(pomodoroSessionTable.channelId, channelId),
        lt(pomodoroSessionTable.startedAt, leftAt),
        or(isNull(pomodoroSessionTable.endedAt), gt(pomodoroSessionTable.endedAt, joinedAt)),
      ),
    );

  const breakSeconds = pomodoroSessions.reduce((sum, session) => {
    const overlapStartedAt = new Date(Math.max(joinedAt.getTime(), session.startedAt.getTime()));
    const overlapEndedAt = new Date(Math.min(leftAt.getTime(), (session.endedAt ?? leftAt).getTime()));
    return sum + getPomodoroBreakSecondsInInterval(
      session.startedAt,
      session.focusMinutes,
      session.breakMinutes,
      overlapStartedAt,
      overlapEndedAt,
    );
  }, 0);

  return Math.max(0, totalSeconds - breakSeconds);
}
