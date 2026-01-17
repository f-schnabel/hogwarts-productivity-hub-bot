/**
 * Backfill points for old voice sessions where points is NULL
 * Usage: npx tsx scripts/backfill-session-points.ts [--dry-run]
 */

import "dotenv/config";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import { drizzle } from "drizzle-orm/node-postgres";
import { and, asc, eq, isNull } from "drizzle-orm";
import { userTable, voiceSessionTable } from "../src/db/schema.ts";
import { calculatePoints } from "../src/services/pointsService.ts";

dayjs.extend(utc);
dayjs.extend(timezone);

const dryRun = process.argv.includes("--dry-run");

// Create standalone db connection
const db = drizzle({
  connection: {
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    host: process.env.DB_HOST,
    ssl: false,
  },
  casing: "snake_case",
});

interface SessionUpdate {
  sessionId: number;
  points: number;
  day: string;
  duration: number;
}

async function main() {
  console.log(`Running in ${dryRun ? "DRY RUN" : "LIVE"} mode\n`);

  // Get all users who have sessions with points IS NULL and isTracked = true
  const usersWithNullSessions = await db
    .selectDistinct({ discordId: voiceSessionTable.discordId })
    .from(voiceSessionTable)
    .where(and(isNull(voiceSessionTable.points), eq(voiceSessionTable.isTracked, true)));

  console.log(`Found ${usersWithNullSessions.length} users with null-points sessions\n`);

  const allUpdates: SessionUpdate[] = [];

  for (const { discordId } of usersWithNullSessions) {
    // Get user's timezone
    const [user] = await db
      .select({ timezone: userTable.timezone })
      .from(userTable)
      .where(eq(userTable.discordId, discordId));

    const tz = user?.timezone ?? "UTC";

    // Get all null-points tracked sessions for this user
    const sessions = await db
      .select({
        id: voiceSessionTable.id,
        joinedAt: voiceSessionTable.joinedAt,
        duration: voiceSessionTable.duration,
      })
      .from(voiceSessionTable)
      .where(
        and(
          eq(voiceSessionTable.discordId, discordId),
          eq(voiceSessionTable.isTracked, true),
          isNull(voiceSessionTable.points),
        ),
      )
      .orderBy(asc(voiceSessionTable.joinedAt));

    // Group sessions by day in user's timezone
    const sessionsByDay = new Map<string, typeof sessions>();
    for (const session of sessions) {
      const day = dayjs(session.joinedAt).tz(tz).format("YYYY-MM-DD");
      const existing = sessionsByDay.get(day) ?? [];
      existing.push(session);
      sessionsByDay.set(day, existing);
    }

    // Calculate points for each session
    for (const [day, daySessions] of sessionsByDay) {
      let cumulativeVoiceTime = 0;

      for (const session of daySessions) {
        const duration = session.duration ?? 0;
        const points = calculatePoints(cumulativeVoiceTime, cumulativeVoiceTime + duration);
        cumulativeVoiceTime += duration;

        allUpdates.push({
          sessionId: session.id,
          points,
          day,
          duration,
        });
      }
    }

    console.log(`User ${discordId}: ${sessions.length} sessions across ${sessionsByDay.size} days`);
  }

  console.log(`\nTotal sessions to update: ${allUpdates.length}`);
  console.log(`Total points to assign: ${allUpdates.reduce((sum, u) => sum + u.points, 0)}\n`);

  if (dryRun) {
    console.log("Updates that would be applied:");
    for (const update of allUpdates) {
      console.log(`  Session ${update.sessionId}: ${update.points} pts (${update.day}, ${update.duration}s)`);
    }
    console.log("\nRun without --dry-run to apply changes.");
  } else {
    // Apply updates in a transaction
    await db.transaction(async (tx) => {
      for (const update of allUpdates) {
        await tx
          .update(voiceSessionTable)
          .set({ points: update.points })
          .where(eq(voiceSessionTable.id, update.sessionId));
      }
    });
    console.log("Updates applied successfully!");
  }

  process.exit(0);
}

main().catch((err: unknown) => {
  console.error("Error:", err);
  process.exit(1);
});
