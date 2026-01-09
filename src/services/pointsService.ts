import { eq, inArray, type ExtractTablesWithRelations } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import type { NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import type { Schema } from "../db/db.ts";
import { houseScoreboardTable, userTable } from "../db/schema.ts";
import { updateScoreboardMessages } from "./scoreboardService.ts";
import { alertOwner } from "../utils/alerting.ts";
import { FIRST_HOUR_POINTS, MAX_HOURS_PER_DAY, REST_HOURS_POINTS } from "../utils/constants.ts";

export async function awardPoints(
  db: PgTransaction<NodePgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>> | typeof import("../db/db.ts").db,
  discordId: string,
  points: number,
  opId: string,
) {
  // Update user's total points
  const house = await db
    .update(userTable)
    .set({
      dailyPoints: sql`${userTable.dailyPoints} + ${points}`,
      monthlyPoints: sql`${userTable.monthlyPoints} + ${points}`,
      totalPoints: sql`${userTable.totalPoints} + ${points}`,
    })
    .where(eq(userTable.discordId, discordId))
    .returning({ house: userTable.house })
    .then(([row]) => row?.house);

  if (house) {
    const scoreboards = await db.select().from(houseScoreboardTable).where(eq(houseScoreboardTable.house, house));
    const brokenIds = await updateScoreboardMessages(db, scoreboards, opId);
    if (brokenIds.length > 0) {
      await alertOwner(`Removed ${brokenIds.length} broken house scoreboard message entries for house ${house}.`, opId);
      await db.delete(houseScoreboardTable).where(inArray(houseScoreboardTable.id, brokenIds));
    }
  }
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
