import { type Schema } from "../db/db.ts";
import { userTable, voiceSessionTable } from "../db/schema.ts";
import { and, eq, inArray, isNull, sql, type ExtractTablesWithRelations } from "drizzle-orm";
import { FIRST_HOUR_POINTS, REST_HOURS_POINTS, MAX_HOURS_PER_DAY } from "../utils/constants.ts";
import type { PgTransaction } from "drizzle-orm/pg-core";
import type { NodePgDatabase, NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import type { VoiceSession } from "../types.ts";
import type { GuildMember } from "discord.js";
import assert from "node:assert/strict";
import { awardPoints } from "./utils.ts";
import { updateYearRole } from "./yearRoleUtils.ts";
import { createLogger } from "./logger.ts";

const log = createLogger("Voice");

const EXCLUDE_VOICE_CHANNEL_IDS = process.env.EXCLUDE_VOICE_CHANNEL_IDS?.split(",") ?? [];

// Start a voice session when user joins VC (timezone-aware)
export async function startVoiceSession(
  session: VoiceSession,
  db: PgTransaction<NodePgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>> | NodePgDatabase<Schema>,
  opId: string,
) {
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
  db: PgTransaction<NodePgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>> | NodePgDatabase<Schema>,
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
    if (member) {
      await updateYearRole(member, user.monthlyVoiceTime, opId);
    }
  });
}

export function calculatePointsHelper(voiceTime: number): number {
  const ONE_HOUR = 60 * 60;
  const FIVE_MINUTES = 5 * 60;

  // 5 min grace period
  voiceTime += FIVE_MINUTES;
  // Convert seconds to hours
  voiceTime = Math.floor(voiceTime / ONE_HOUR);

  if (voiceTime < 1) {
    return 0; // No points for less than an hour
  }

  let points = FIRST_HOUR_POINTS;

  if (voiceTime >= 2) {
    const hoursCapped = Math.min(voiceTime, MAX_HOURS_PER_DAY) - 1;

    points += REST_HOURS_POINTS * hoursCapped;
  }

  return points;
}

export function calculatePoints(oldDailyVoiceTime: number, newDailyVoiceTime: number): number {
  return calculatePointsHelper(newDailyVoiceTime) - calculatePointsHelper(oldDailyVoiceTime);
}

export function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  const parts = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}min`);
  if (secs > 0 || parts.length === 0) parts.push(`${secs}sec`);
  return parts.join(" ");
}
