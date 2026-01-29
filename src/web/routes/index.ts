import type { House } from "@/common/types.ts";
import { db, getMonthStartDate } from "@/db/db.ts";
import { userTable } from "@/db/schema.ts";
import { desc } from "drizzle-orm";
import { and, gt } from "drizzle-orm/sql/expressions/conditions";
import { sql } from "drizzle-orm/sql/sql";
import { getHouseColor } from "../utils.ts";
import dayjs from "dayjs";
import type { Router } from "express";

/**
 * Mystery mode: last 3 days of calendar month, but not within 2 days of reset
 * Can be bypassed with secret param, or forced with mystery=1 param
 */
async function isMysteryMode(query: Record<string, unknown>): Promise<boolean> {
  if (query["secret"] === process.env["MYSTERY_SECRET"]) return false;
  if (query["mystery"] === "1") return true;

  const now = dayjs();
  const isLastThreeDays = now.date() > now.daysInMonth() - 3;
  if (!isLastThreeDays) return false;

  const monthStart = await getMonthStartDate();
  const daysSinceReset = now.diff(monthStart, "day");
  if (daysSinceReset <= 1) return false;

  return true;
}

// Home - House scoreboard
export default function registerIndexRoute(app: Router) {
  app.get("/", async (req, res) => {
    const unweightedHouseData = await db
      .select({
        house: userTable.house,
        totalPoints: sql<number>`sum(${userTable.monthlyPoints})`.as("total_points"),
        memberCount: sql<number>`count(*)`.as("member_count"),
      })
      .from(userTable)
      .where(and(sql`${userTable.house} IS NOT NULL`, gt(userTable.monthlyPoints, 0)))
      .groupBy(userTable.house)
      .orderBy(desc(sql`total_points`));

    const weightedHouseData = await db
      .select({
        house: userTable.house,
        totalPoints: sql<number>`sum(${userTable.monthlyPoints}) / count(*)`.as("total_points"),
        memberCount: sql<number>`count(*)`.as("member_count"),
      })
      .from(userTable)
      .where(and(sql`${userTable.house} IS NOT NULL`, gt(userTable.monthlyPoints, 15)))
      .groupBy(userTable.house)
      .orderBy(desc(sql`total_points`));

    // Create a map from unweighted data
    const unweightedMap = new Map(
      unweightedHouseData
        .filter((h): h is typeof h & { house: House } => h.house !== null)
        .map((h) => [h.house, { unweightedPoints: h.totalPoints, totalMemberCount: h.memberCount }]),
    );

    let houses = weightedHouseData
      .filter((h): h is typeof h & { house: House } => h.house !== null)
      .map((h) => ({
        name: h.house,
        color: getHouseColor(h.house),
        rawPoints: h.totalPoints,
        points: h.totalPoints.toLocaleString(),
        memberCount: h.memberCount,
        unweightedPoints: unweightedMap.get(h.house)?.unweightedPoints.toLocaleString() ?? "0",
        totalMemberCount: unweightedMap.get(h.house)?.totalMemberCount ?? 0,
        rank: 1,
      }));

    // Calculate ranks with ties (same points = same rank)
    houses.forEach((current, i) => {
      const prev = houses[i - 1];
      current.rank = prev?.rawPoints === current.rawPoints ? prev.rank : i + 1;
    });

    const mysteryMode = await isMysteryMode(req.query);
    if (mysteryMode) {
      // Shuffle houses so order doesn't reveal ranking
      houses = houses.sort(() => Math.random() - 0.5);
    }

    res.render("houses", { title: "House Standings", houses, mysteryMode });
  });
}
