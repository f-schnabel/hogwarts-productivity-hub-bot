import { type DbOrTx } from "../db/db.ts";
import { userTable, voiceSessionTable } from "../db/schema.ts";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { VoiceSession } from "../types.ts";
import type { GuildMember } from "discord.js";
import assert from "node:assert/strict";
import { updateYearRole } from "./yearRoleUtils.ts";
import { createLogger } from "./logger.ts";
import { formatDuration } from "./interactionUtils.ts";
import { alertOwner } from "./alerting.ts";
import { awardPoints, calculatePoints } from "../services/pointsService.ts";

const log = createLogger("Voice");

const EXCLUDE_VOICE_CHANNEL_IDS = process.env.EXCLUDE_VOICE_CHANNEL_IDS?.split(",") ?? [];

// Start a voice session when user joins VC (timezone-aware)
export async function startVoiceSession(session: VoiceSession, db: DbOrTx, opId: string) {
  const channelId = session.channelId;
  const channelName = session.channelName;
  const ctx = { opId, userId: session.discordId, user: session.username, channel: channelName };

  if (channelId === null || EXCLUDE_VOICE_CHANNEL_IDS.includes(channelId)) {
    log.debug("Skipped excluded channel", ctx);
    return;
  }
  assert(channelName !== null, "Channel name must be provided for voice session");

  await db.transaction(async (db) => {
    const existingVoiceSessions = await db
      .select()
      .from(voiceSessionTable)
      .where(and(eq(voiceSessionTable.discordId, session.discordId), isNull(voiceSessionTable.leftAt)));

    if (existingVoiceSessions.length > 0) {
      log.warn("Existing session found, closing first", { ...ctx, existingSessions: existingVoiceSessions.length });
      await alertOwner(
        `Existing voice session(s) found when starting new voice session for user ${session.username} (${session.discordId}) in channel ${channelName} (${channelId}). Closing existing session(s).`,
        opId,
      );
      await endVoiceSession(session, db, opId, false); // End existing session without tracking
    }

    await db.insert(voiceSessionTable).values({ discordId: session.discordId, channelId, channelName });

    log.info("Session started", ctx);
  });
}

/** End a voice session when user leaves VC
 *  @param isTracked - If false, do not update user stats (for deleting old sessions)
 *  @param opId - Operation ID for tracing
 *  @param member - GuildMember to update year role (optional)
 */
export async function endVoiceSession(
  session: VoiceSession,
  db: DbOrTx,
  opId: string,
  isTracked = true,
  member?: GuildMember,
) {
  const channelId = session.channelId;
  const ctx = { opId, userId: session.discordId, user: session.username, channel: session.channelName };

  if (channelId === null || EXCLUDE_VOICE_CHANNEL_IDS.includes(channelId)) {
    log.debug("Skipped excluded channel", ctx);
    return;
  }
  await db.transaction(async (db) => {
    const existingVoiceSession = await db
      .select({ id: voiceSessionTable.id })
      .from(voiceSessionTable)
      .where(
        and(
          eq(voiceSessionTable.discordId, session.discordId),
          inArray(voiceSessionTable.channelId, [channelId, "unknown"]),
          isNull(voiceSessionTable.leftAt),
        ),
      );
    if (isTracked && existingVoiceSession.length !== 1) {
      log.error("Unexpected session count", { ...ctx, found: existingVoiceSession.length, expected: 1 });
      await alertOwner(
        `Unexpected session count when ending voice session for user ${session.username} (${session.discordId}) in channel ${session.channelName ?? "Unknown"} (${channelId}). Found ${existingVoiceSession.length}, expected 1.`,
        opId,
      );
      return;
    }

    const [voiceSessionWithDuration, ...extra] = await db
      .update(voiceSessionTable)
      .set({
        leftAt: new Date(),
        isTracked, // Only track if not deleting old session
      })
      .where(
        inArray(
          voiceSessionTable.id,
          existingVoiceSession.map((s) => s.id),
        ),
      )
      .returning({
        id: voiceSessionTable.id,
        duration: voiceSessionTable.duration,
      });

    if (!isTracked) {
      log.debug("Session closed (untracked)", ctx);
      return;
    }

    assert(voiceSessionWithDuration !== undefined, `Expected exactly one voice session to end, but found none`);
    assert(extra.length === 0, `Expected exactly one voice session to end, but found ${extra.length} extra rows`);

    const duration = voiceSessionWithDuration.duration ?? 0;

    // Update user's voice time stats
    const [user] = await db
      .update(userTable)
      .set({
        dailyVoiceTime: sql`${userTable.dailyVoiceTime} + ${duration}`,
        monthlyVoiceTime: sql`${userTable.monthlyVoiceTime} + ${duration}`,
        totalVoiceTime: sql`${userTable.totalVoiceTime} + ${duration}`,
      })
      .where(eq(userTable.discordId, session.discordId))
      .returning({
        dailyVoiceTime: userTable.dailyVoiceTime,
        monthlyVoiceTime: userTable.monthlyVoiceTime,
        house: userTable.house,
      });
    assert(user !== undefined, `User not found for Discord ID ${session.discordId}`);

    // Calculate and award points for this session
    const oldDailyVoiceTime = user.dailyVoiceTime - duration;
    const newDailyVoiceTime = user.dailyVoiceTime;
    const pointsEarned = calculatePoints(oldDailyVoiceTime, newDailyVoiceTime);

    log.info("Session ended", {
      ...ctx,
      duration: formatDuration(duration),
      points: pointsEarned,
      oldDaily: formatDuration(oldDailyVoiceTime),
      newDaily: formatDuration(newDailyVoiceTime),
    });

    if (pointsEarned > 0) {
      // Award points to user
      await awardPoints(db, session.discordId, pointsEarned, opId);
    }
    await db
      .update(voiceSessionTable)
      .set({ points: pointsEarned })
      .where(eq(voiceSessionTable.id, voiceSessionWithDuration.id));

    // Update year role based on monthly voice time
    if (member && user.house) {
      await updateYearRole(member, user.monthlyVoiceTime, user.house, opId);
    }
  });
}
