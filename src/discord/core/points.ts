import { eq, inArray, sql } from "drizzle-orm";
import { db as globalDb, getMonthStartDate, type DbOrTx } from "@/db/db.ts";
import { houseScoreboardTable, userTable } from "@/db/schema.ts";
import { getHousepointMessages, updateScoreboardMessages } from "../events/interactionCreate/scoreboard/scoreboard.ts";
import { sendAlert } from "@/discord/utils/alerting.ts";
import type { House } from "@/common/types.ts";
import { FIRST_HOUR_POINTS, MAX_HOURS_PER_DAY, REST_HOURS_POINTS } from "@/common/constants.ts";

export async function awardPoints(db: DbOrTx, discordId: string, points: number) {
  // Update user's total points
  const house = await db
    .update(userTable)
    .set({
      dailyPoints:   sql`${userTable.dailyPoints}   + ${points}`,
      monthlyPoints: sql`${userTable.monthlyPoints} + ${points}`,
      totalPoints:   sql`${userTable.totalPoints}   + ${points}`,
    })
    .where(eq(userTable.discordId, discordId))
    .returning({ house: userTable.house })
    .then(([row]) => row?.house);

  await refreshHouseScoreboards(db, house);
}

export async function reversePoints(db: DbOrTx, discordId: string, points: number, awardedAt: Date) {
  const monthStartDate = await getMonthStartDate(db);

  const house = await db
    .update(userTable)
    .set({
      dailyPoints: sql`CASE
        WHEN ${awardedAt} >= ${userTable.lastDailyReset} THEN ${userTable.dailyPoints} - ${points}
        ELSE ${userTable.dailyPoints}
      END`,
      monthlyPoints: sql`CASE
        WHEN ${awardedAt} >= ${monthStartDate} THEN ${userTable.monthlyPoints} - ${points}
        ELSE ${userTable.monthlyPoints}
      END`,
      totalPoints: sql`${userTable.totalPoints} - ${points}`,
    })
    .where(eq(userTable.discordId, discordId))
    .returning({ house: userTable.house })
    .then(([row]) => row?.house);

  await refreshHouseScoreboards(db, house);
}

async function refreshHouseScoreboards(db: DbOrTx, house: House | null | undefined) {
  if (!house) return;

  const scoreboards = await db.select().from(houseScoreboardTable).where(eq(houseScoreboardTable.house, house));
  if (scoreboards.length == 0) return;

  // fire-and-forget: don't block transaction on Discord API calls
  void updateScoreboardMessages(await getHousepointMessages(db, scoreboards)).then(async (brokenIds) => {
    if (brokenIds.length > 0) {
      await sendAlert(`Removed ${brokenIds.length} broken scoreboard entries for ${house}.`);
      await globalDb.delete(houseScoreboardTable).where(inArray(houseScoreboardTable.id, brokenIds));
    }
  });
}

// Hours of voice time that count for points, with a 5 minute grace period
function countedHours(voiceTime: number): number {
  return Math.floor((voiceTime + 5 * 60) / (60 * 60));
}

/**
 * Points for a day's voice time.
 * On the day of a monthly reset, `preResetVoiceTime` is the part of `voiceTime` before the reset: only the
 * hours after the reset count for the new month, and the first-hour bonus is only given if it wasn't earned
 * before the reset that day.
 */
export function calculatePointsHelper(voiceTime: number, preResetVoiceTime = 0): number {
  const preResetHours = Math.min(countedHours(preResetVoiceTime), MAX_HOURS_PER_DAY);
  const hours = Math.min(countedHours(voiceTime - preResetVoiceTime), MAX_HOURS_PER_DAY - preResetHours);
  if (hours < 1) return 0;

  const firstHourPoints = preResetHours >= 1 ? REST_HOURS_POINTS : FIRST_HOUR_POINTS;
  return firstHourPoints + REST_HOURS_POINTS * (hours - 1);
}

export function calculatePoints(oldDailyVoiceTime: number, newDailyVoiceTime: number, preResetVoiceTime = 0): number {
  return (
    calculatePointsHelper(newDailyVoiceTime, preResetVoiceTime) -
    calculatePointsHelper(oldDailyVoiceTime, preResetVoiceTime)
  );
}

/**
 * Voice time of the user's current day from before the monthly reset.
 * The reset clears monthly but not daily voice time, so until the user's next daily reset
 * the difference between the two is the time before the monthly reset.
 */
export function getPreResetVoiceTime(
  user: { dailyVoiceTime: number; monthlyVoiceTime: number; lastDailyReset: Date },
  monthStart: Date,
): number {
  if (user.lastDailyReset >= monthStart) return 0;
  return Math.max(0, user.dailyVoiceTime - user.monthlyVoiceTime);
}
