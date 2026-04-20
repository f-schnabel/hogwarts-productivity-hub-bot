import { eq, inArray, sql } from "drizzle-orm";
import { db as globalDb, getMonthStartDate, type DbOrTx } from "@/db/db.ts";
import { houseScoreboardTable, userTable } from "@/db/schema.ts";
import { getHousepointMessages, updateScoreboardMessages } from "../events/interactionCreate/scoreboard/scoreboard.ts";
import { alertOwner } from "@/discord/utils/alerting.ts";
import type { House } from "@/common/types.ts";
import { FIRST_HOUR_POINTS, MAX_HOURS_PER_DAY, REST_HOURS_POINTS } from "@/common/constants.ts";

export async function awardPoints(db: DbOrTx, discordId: string, points: number) {
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

  await refreshHouseScoreboards(db, house);
}

export async function reverseSubmissionPoints(db: DbOrTx, discordId: string, points: number, reviewedAt: Date) {
  const monthStartDate = await getMonthStartDate();

  const house = await db
    .update(userTable)
    .set({
      dailyPoints: sql`CASE
        WHEN ${reviewedAt} >= ${userTable.lastDailyReset} THEN ${userTable.dailyPoints} - ${points}
        ELSE ${userTable.dailyPoints}
      END`,
      monthlyPoints: sql`CASE
        WHEN ${reviewedAt} >= ${monthStartDate} THEN ${userTable.monthlyPoints} - ${points}
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
  if (house) {
    const scoreboards = await db.select().from(houseScoreboardTable).where(eq(houseScoreboardTable.house, house));
    if (scoreboards.length > 0) {
      // fire-and-forget: don't block transaction on Discord API calls
      void updateScoreboardMessages(await getHousepointMessages(db, scoreboards)).then(async (brokenIds) => {
        if (brokenIds.length > 0) {
          await alertOwner(`Removed ${brokenIds.length} broken scoreboard entries for ${house}.`);
          await globalDb.delete(houseScoreboardTable).where(inArray(houseScoreboardTable.id, brokenIds));
        }
      });
    }
  }
}

export function calculatePointsHelper(voiceTime: number): number {
  const ONE_HOUR = 60 * 60;
  const FIVE_MINUTES = 5 * 60;

  voiceTime += FIVE_MINUTES;
  voiceTime = Math.floor(voiceTime / ONE_HOUR);

  if (voiceTime < 1) {
    return 0;
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
