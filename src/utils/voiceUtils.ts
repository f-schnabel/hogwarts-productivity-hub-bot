import { type Schema } from "../db/db.ts";
import { userTable, voiceSessionTable } from "../db/schema.ts";
import { and, eq, inArray, isNull, sql, type ExtractTablesWithRelations } from "drizzle-orm";
import { FIRST_HOUR_POINTS, REST_HOURS_POINTS, MAX_HOURS_PER_DAY } from "../utils/constants.ts";
import type { PgTransaction } from "drizzle-orm/pg-core";
import type { NodePgDatabase, NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import type { VoiceSession } from "../types.ts";
import assert from "node:assert/strict";
import { awardPoints } from "./utils.ts";

// Start a voice session when user joins VC (timezone-aware)
export async function startVoiceSession(
  session: VoiceSession,
  db: PgTransaction<NodePgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>> | NodePgDatabase<Schema>,
) {
  const channelId = session.channelId;
  const channelName = session.channelName;
  if (channelId === null || process.env.EXCLUDE_VOICE_CHANNEL_IDS.split(",").includes(channelId)) {
    return;
  }
  assert(channelName !== null, "Channel name must be provided for voice session");

  await db.transaction(async (db) => {
    const existingVoiceSessions = await db
      .select()
      .from(voiceSessionTable)
      .where(and(eq(voiceSessionTable.discordId, session.discordId), isNull(voiceSessionTable.leftAt)));

    if (existingVoiceSessions.length > 0) {
      console.error(`Voice session already active for ${session.username}, closing and starting a new one`);
      await endVoiceSession(session, db, false); // End existing session without tracking
    }

    await db.insert(voiceSessionTable).values({ discordId: session.discordId, channelId, channelName });

    console.log(`Voice session started for ${session.username}`);
  });
}

/** End a voice session when user leaves VC
 *  @param isTracked - If false, do not update user stats (for deleting old sessions)
 */
export async function endVoiceSession(
  session: VoiceSession,
  db: PgTransaction<NodePgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>> | NodePgDatabase<Schema>,
  isTracked = true,
) {
  const channelId = session.channelId;
  if (channelId === null || process.env.EXCLUDE_VOICE_CHANNEL_IDS.split(",").includes(channelId)) {
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
      console.error(
        `Could not end voice session, found ${existingVoiceSession.length} active voice session found for ${session.username}`,
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
        duration: voiceSessionTable.duration,
      });

    if (!isTracked) {
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
      });
    assert(user !== undefined, `User not found for Discord ID ${session.discordId}`);

    // Calculate and award points for this session
    const oldDailyVoiceTime = user.dailyVoiceTime - duration;
    const newDailyVoiceTime = user.dailyVoiceTime;
    const pointsEarned = calculatePoints(oldDailyVoiceTime, newDailyVoiceTime);
    console.log(
      `Voice session ended for ${session.username}: ${duration} seconds, awarded ${pointsEarned} points (oldDailyVoiceTime: ${oldDailyVoiceTime}, newDailyVoiceTime: ${newDailyVoiceTime})`,
    );

    if (pointsEarned > 0) {
      // Award points to user
      await awardPoints(db, session.discordId, pointsEarned);
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
