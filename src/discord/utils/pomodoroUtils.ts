import { db } from "@/db/db.ts";
import { pomodoroSessionTable } from "@/db/schema.ts";
import { MAX_SESSION_AGE_MS } from "@/common/constants.ts";
import { createLogger } from "@/common/logging/logger.ts";
import { type BaseGuildVoiceChannel, type MessageCreateOptions, type MessageEditOptions } from "discord.js";
import { fetchVoiceChannel, getMembers } from "@/discord/events/voiceStateUpdate/voiceSession.ts";
import { parsePomodoroChannelName } from "@/discord/utils/pomodoroConfig.ts";
import { getPomodoroPhase } from "@/discord/utils/pomodoroPhase.ts";
import { buildPomodoroStatusContent } from "@/discord/utils/pomodoroMessages.ts";
import assert from "node:assert/strict";
import { and, eq, getTableColumns, isNull, sql } from "drizzle-orm";

const log = createLogger("Pomodoro");
const timers = new Map<string, NodeJS.Timeout>();

type PomodoroSessionRow = typeof pomodoroSessionTable.$inferSelect;

export async function getActivePomodoroSession(channelId: string | null, dbOrTx = db): Promise<PomodoroSessionRow | null> {
  if (!channelId) return null;
  return await dbOrTx
    .select()
    .from(pomodoroSessionTable)
    .where(and(eq(pomodoroSessionTable.channelId, channelId), isNull(pomodoroSessionTable.endedAt)))
    .then(([session]) => session ?? null);
}

export async function ensurePomodoroSessionForChannel(channel: BaseGuildVoiceChannel | null): Promise<PomodoroSessionRow | null> {
  if (!channel) return null;

  const config = parsePomodoroChannelName(channel.name);
  if (!config) return null;

  const now = new Date();
  // Upsert against the partial unique index (channel_id WHERE ended_at IS NULL) so concurrent
  // joins can never create a second active row. xmax = 0 distinguishes a fresh insert from an
  // update so we only boot timers/status-message once per session.
  const [row] = await db
    .insert(pomodoroSessionTable)
    .values({
      channelId: channel.id,
      channelName: channel.name,
      focusMinutes: config.focusMinutes,
      breakMinutes: config.breakMinutes,
      stage: "FOCUS",
      stageStartedAt: now,
      nextStageAt: getPomodoroPhase(now, config.focusMinutes, config.breakMinutes, now).nextStageAt,
      startedAt: now,
    })
    .onConflictDoUpdate({
      target: pomodoroSessionTable.channelId,
      targetWhere: sql`${pomodoroSessionTable.endedAt} IS NULL`,
      set: { channelName: channel.name },
    })
    .returning({
      ...getTableColumns(pomodoroSessionTable),
      wasInserted: sql<boolean>`xmax = 0`,
    });
  assert(row, `Failed to upsert pomodoro session for channel ${channel.id}`);

  const { wasInserted, ...session } = row;
  if (!wasInserted) return session;

  scheduleTimer(session.channelId, session.nextStageAt);
  const sessionWithMessage = await safeUpsertMessage(session, channel);
  log.info("Pomodoro session started", {
    channelId: channel.id,
    channel: channel.name,
    focusMinutes: session.focusMinutes,
    breakMinutes: session.breakMinutes,
  });

  return sessionWithMessage;
}

export async function maybeFinalizePomodoroSession(
  channelId: string | null,
  leavingMemberId: string,
): Promise<PomodoroSessionRow | null> {
  const session = await getActivePomodoroSession(channelId);
  if (!session) return null;

  const channel = await fetchVoiceChannel(session.channelId);
  if (!channel || getMembers(channel, leavingMemberId).length === 0) {
    return await finalizePomodoroSession(session.channelId, session.id, channel);
  }

  return await safeUpsertMessage(session, channel);
}

export async function restorePomodoroSessions() {
  const sessions = await db.select().from(pomodoroSessionTable).where(isNull(pomodoroSessionTable.endedAt));

  for (const session of sessions) {
    const now = new Date();
    const channel = await fetchVoiceChannel(session.channelId);
    const members = getMembers(channel);
    const sessionAgeMs = now.getTime() - session.startedAt.getTime();
    const isStale = sessionAgeMs > MAX_SESSION_AGE_MS;

    if (!channel || members.length === 0) {
      await finalizePomodoroSession(session.channelId, session.id, channel);
      continue;
    }

    if (isStale) {
      await finalizePomodoroSession(session.channelId, session.id, channel);

      const restartedSession = await ensurePomodoroSessionForChannel(channel);
      if (!restartedSession) continue;

      await safeUpsertMessage(restartedSession, channel);
      log.info("Stale pomodoro restarted", {
        channelId: channel.id,
        channel: channel.name,
        participants: members.length,
      });
      continue;
    }

    const phase = getPomodoroPhase(session.startedAt, session.focusMinutes, session.breakMinutes, now);
    const [updated] = await db
      .update(pomodoroSessionTable)
      .set({
        channelName: channel.name,
        stage: phase.stage,
        stageStartedAt: phase.stageStartedAt,
        nextStageAt: phase.nextStageAt,
      })
      .where(eq(pomodoroSessionTable.id, session.id))
      .returning();
    const current = updated ?? { ...session, ...phase, channelName: channel.name };

    scheduleTimer(current.channelId, current.nextStageAt);
    await safeUpsertMessage(current, channel);
    log.info("Pomodoro session restored", {
      channelId: session.channelId,
      channel: session.channelName,
      stage: current.stage,
      elapsedCycles: phase.elapsedCycles,
      participants: members.length,
    });
  }
}

export async function finalizePomodoroSession(channelId: string, sessionId: number, channel: BaseGuildVoiceChannel | null) {
  clearTimer(channelId);

  const [closed] = await db
    .update(pomodoroSessionTable)
    .set({ endedAt: new Date() })
    .where(eq(pomodoroSessionTable.id, sessionId))
    .returning();
  assert(closed, `Failed to finalize pomodoro session for channel ${channelId}`);

  if (channel) {
    await safeUpsertMessage(closed, channel, true);
  }

  log.info("Pomodoro session ended", {
    channelId,
    channel: closed.channelName,
  });

  return closed;
}

export function scheduleTimer(channelId: string, nextStageAt: Date) {
  clearTimer(channelId);
  timers.set(
    channelId,
    setTimeout(() => {
      void advancePomodoroSession(channelId);
    }, Math.max(0, nextStageAt.getTime() - Date.now())),
  );
}

export async function upsertMessage(
  session: PomodoroSessionRow,
  channel: BaseGuildVoiceChannel,
  ended = false,
): Promise<PomodoroSessionRow> {
  if (!channel.isTextBased()) {
    log.warn("Pomodoro channel has no text chat", { channelId: channel.id, channel: channel.name });
    return session;
  }

  const participantIds = getMembers(channel).map((member) => member.id);
  const payload: MessageEditOptions & MessageCreateOptions = {
    content: buildPomodoroStatusContent(session, participantIds, {
      ended,
      channelName: channel.name,
    }),
    allowedMentions: { users: participantIds, parse: [] },
  };

  if (session.statusMessageId) {
    try {
      const message = await channel.messages.fetch(session.statusMessageId);
      await message.edit(payload);
      return session;
    } catch {
      // Fall through to recreate the status message if it was deleted.
    }
  }

  const message = await channel.send(payload);
  return await db
    .update(pomodoroSessionTable)
    .set({ statusMessageId: message.id })
    .where(eq(pomodoroSessionTable.id, session.id))
    .returning()
    .then(([updated]) => updated ?? { ...session, statusMessageId: message.id });
}

export async function safeUpsertMessage(
  session: PomodoroSessionRow,
  channel: BaseGuildVoiceChannel,
  ended = false,
): Promise<PomodoroSessionRow> {
  try {
    return await upsertMessage(session, channel, ended);
  } catch (error) {
    log.error("Pomodoro status message update failed", {
      channelId: session.channelId,
      channel: channel.name,
      sessionId: session.id,
    }, error);
    return session;
  }
}

async function advancePomodoroSession(channelId: string) {
  const session = await getActivePomodoroSession(channelId);
  if (!session) {
    clearTimer(channelId);
    return;
  }

  const channel = await fetchVoiceChannel(channelId);
  if (!channel) {
    await finalizePomodoroSession(session.channelId, session.id, channel);
    return;
  }

  await transitionPomodoroSession(session, channel, new Date());
}

async function transitionPomodoroSession(session: PomodoroSessionRow, channel: BaseGuildVoiceChannel, boundary: Date) {
  const phase = getPomodoroPhase(session.startedAt, session.focusMinutes, session.breakMinutes, boundary);
  const [updated] = await db
    .update(pomodoroSessionTable)
    .set({
      channelName: channel.name,
      stage: phase.stage,
      stageStartedAt: phase.stageStartedAt,
      nextStageAt: phase.nextStageAt,
    })
    .where(eq(pomodoroSessionTable.id, session.id))
    .returning();

  const current = updated ?? { ...session, ...phase, channelName: channel.name };

  scheduleTimer(current.channelId, current.nextStageAt);
  const sessionWithMessage = await safeUpsertMessage(current, channel);
  log.info("Pomodoro stage advanced", {
    channelId: channel.id,
    channel: channel.name,
    stage: phase.stage,
  });
  return sessionWithMessage;
}

function clearTimer(channelId: string) {
  const timer = timers.get(channelId);
  if (!timer) return;

  clearTimeout(timer);
  timers.delete(channelId);
}
