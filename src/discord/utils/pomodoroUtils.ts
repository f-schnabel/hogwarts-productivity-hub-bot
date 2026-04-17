import { db, ensureUserExists } from "@/db/db.ts";
import { pomodoroSessionTable, userTable, voiceSessionTable } from "@/db/schema.ts";
import { MAX_SESSION_AGE_MS } from "@/common/constants.ts";
import type { PomodoroChannelConfig, PomodoroStage } from "@/common/types.ts";
import { createLogger } from "@/common/logging/logger.ts";
import { time, userMention, type BaseGuildVoiceChannel, type GuildMember, type MessageCreateOptions, type MessageEditOptions } from "discord.js";
import { closeVoiceSessionUntracked, endVoiceSession, fetchVoiceChannel, getMembers, startVoiceSession } from "@/discord/events/voiceStateUpdate/voiceSession.ts";
import dayjs from "dayjs";
import assert from "node:assert/strict";
import { and, count, eq, getTableColumns, isNull, sql } from "drizzle-orm";

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

function parsePomodoroChannelName(name: string | null): PomodoroChannelConfig | null {
  if (!name) return null;
  const match = /^⏰ Time Turner \((\d+)\/(\d+) Pomo\)/.exec(name);
  if (!match) return null;

  const focusMinutes = Number.parseInt(match[1] ?? "", 10);
  const breakMinutes = Number.parseInt(match[2] ?? "", 10);

  if (!Number.isInteger(focusMinutes) || !Number.isInteger(breakMinutes) || focusMinutes <= 0 || breakMinutes <= 0) {
    return null;
  }

  return { focusMinutes, breakMinutes };
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
      nextStageAt: dayjs(now).add(config.focusMinutes, "minute").toDate(),
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

  const sessionWithMessage = await upsertMessage(session, channel);
  scheduleTimer(sessionWithMessage.channelId, sessionWithMessage.nextStageAt);
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

  return await upsertMessage(session, channel);
}

export async function restorePomodoroSessions() {
  const sessions = await db.select().from(pomodoroSessionTable).where(isNull(pomodoroSessionTable.endedAt));

  for (const session of sessions) {
    const now = new Date();
    const channel = await fetchVoiceChannel(session.channelId);
    const members = getMembers(channel);
    const overdueMs = now.getTime() - session.nextStageAt.getTime();
    const isOverdue = overdueMs >= 0;
    const isStale = overdueMs > MAX_SESSION_AGE_MS;

    if (!channel || members.length === 0) {
      if (isStale) {
        await closeVoiceSessionsUntracked(session.channelId);
      } else {
        await closeVoiceSessions(session.channelId, now);
      }
      await finalizePomodoroSession(session.channelId, session.id, channel);
      continue;
    }

    if (isStale) {
      await closeVoiceSessionsUntracked(session.channelId);
      await finalizePomodoroSession(session.channelId, session.id, channel);

      const restartedSession = await ensurePomodoroSessionForChannel(channel);
      if (!restartedSession) continue;

      await startVoiceSessions(members, now);
      await upsertMessage(restartedSession, channel);
      log.info("Stale pomodoro restarted", {
        channelId: channel.id,
        channel: channel.name,
        participants: members.length,
      });
      continue;
    }

    if (!isOverdue) {
      await syncVoiceSessionsForStage(session, channel, members, now);
      await upsertMessage(session, channel);
      scheduleTimer(session.channelId, session.nextStageAt);
      log.info("Pomodoro session restored", {
        channelId: session.channelId,
        channel: session.channelName,
        stage: session.stage,
        participants: members.length,
      });
      continue;
    }

    const current = await transitionPomodoroSession(session, channel, now);
    log.info("Pomodoro session restored with single transition", {
      channelId: session.channelId,
      channel: session.channelName,
      stage: current.stage,
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
    await upsertMessage(closed, channel, true);
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

export async function closeVoiceSessions(channelId: string, leftAt: Date) {
  for (const session of await getOpenVoiceSessions(channelId)) {
    await endVoiceSession(session, db, leftAt);
  }
}

export async function startVoiceSessions(members: GuildMember[], joinedAt: Date) {
  for (const member of members) {
    const alreadyOpen = await db
      .select({ count: count() })
      .from(voiceSessionTable)
      .where(and(eq(voiceSessionTable.discordId, member.id), isNull(voiceSessionTable.leftAt)))
      .then(([rows]) => (rows?.count ?? 0) > 0);

    if (alreadyOpen || !member.voice.channel) continue;

    await ensureUserExists(member, member.id, member.user.username);
    await startVoiceSession(
      {
        discordId: member.id,
        username: member.user.username,
        channelId: member.voice.channel.id,
        channelName: member.voice.channel.name,
      },
      db,
      joinedAt,
    );
  }
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

async function advancePomodoroSession(channelId: string) {
  const session = await getActivePomodoroSession(channelId);
  if (!session) {
    clearTimer(channelId);
    return;
  }

  const channel = await fetchVoiceChannel(channelId);
  if (!channel) {
    await closeVoiceSessions(channelId, new Date());
    await finalizePomodoroSession(session.channelId, session.id, channel);
    return;
  }

  await transitionPomodoroSession(session, channel, new Date());
}

async function transitionPomodoroSession(session: PomodoroSessionRow, channel: BaseGuildVoiceChannel, boundary: Date) {
  const nextStage: PomodoroStage = session.stage === "FOCUS" ? "BREAK" : "FOCUS";
  const [updated] = await db
    .update(pomodoroSessionTable)
    .set({
      channelName: channel.name,
      stage: nextStage,
      stageStartedAt: boundary,
      nextStageAt: dayjs(boundary).add(nextStage === "FOCUS" ? session.focusMinutes : session.breakMinutes, "minute").toDate(),
    })
    .where(eq(pomodoroSessionTable.id, session.id))
    .returning();

  const current = updated ?? session;
  if (nextStage === "BREAK") {
    await closeVoiceSessions(channel.id, boundary);
  } else {
    await startVoiceSessions(getMembers(channel), boundary);
  }

  const sessionWithMessage = await upsertMessage(current, channel);
  scheduleTimer(sessionWithMessage.channelId, sessionWithMessage.nextStageAt);
  log.info("Pomodoro stage advanced", {
    channelId: channel.id,
    channel: channel.name,
    stage: nextStage,
  });
  return sessionWithMessage;
}

async function syncVoiceSessionsForStage(
  session: PomodoroSessionRow,
  channel: BaseGuildVoiceChannel,
  members: GuildMember[],
  now: Date,
) {
  await closeVoiceSessionsForMissingMembers(channel, now);

  if (session.stage === "FOCUS") {
    await startVoiceSessions(members, session.stageStartedAt);
    return;
  }

  await closeVoiceSessions(channel.id, now);
}

async function closeVoiceSessionsUntracked(channelId: string) {
  for (const session of await getOpenVoiceSessions(channelId)) {
    await closeVoiceSessionUntracked(session, db);
  }
}

async function closeVoiceSessionsForMissingMembers(channel: BaseGuildVoiceChannel, leftAt: Date) {
  const presentIds = new Set(getMembers(channel).map((member) => member.id));

  for (const session of await getOpenVoiceSessions(channel.id)) {
    if (presentIds.has(session.discordId)) continue;
    await endVoiceSession(session, db, leftAt);
  }
}

async function getOpenVoiceSessions(channelId: string) {
  return await db
    .select({
      discordId: voiceSessionTable.discordId,
      username: userTable.username,
      channelId: voiceSessionTable.channelId,
      channelName: voiceSessionTable.channelName,
    })
    .from(voiceSessionTable)
    .innerJoin(userTable, eq(userTable.discordId, voiceSessionTable.discordId))
    .where(and(eq(voiceSessionTable.channelId, channelId), isNull(voiceSessionTable.leftAt)));
}

function clearTimer(channelId: string) {
  const timer = timers.get(channelId);
  if (!timer) return;

  clearTimeout(timer);
  timers.delete(channelId);
}

function buildPomodoroStatusContent(
  session: PomodoroSessionRow,
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
