import { HOUSE_COLORS } from "@/common/constants.ts";
import {
  getMonthStartDate,
  getWeightedHousePoints,
  getUnweightedHousePoints,
  getDailyUserPointEvents,
  db,
} from "@/db/db.ts";
import { buildHousePaceChart, getHouseColor } from "../utils.ts";
import dayjs from "dayjs";
import type { Router } from "express";
import type { House } from "@/common/types.ts";

/**
 * Mystery mode: last 3 days of calendar month, but not within 2 days of reset
 * Can be bypassed with secret param, or forced with mystery=1 param
 */
async function isMysteryMode(query: Record<string, unknown>): Promise<boolean> {
  if (query["secret"] === process.env.MYSTERY_SECRET) return false;
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
    const monthStart = await getMonthStartDate();
    const [unweightedHouseData, weightedHouseData, dailyEvents] = await Promise.all([
      getUnweightedHousePoints(db),
      getWeightedHousePoints(db),
      getDailyUserPointEvents(db, monthStart),
    ]);

    const unweightedMap = new Map(unweightedHouseData.map((h) =>
      [h.house, { unweightedPoints: h.totalPoints, totalMemberCount: h.memberCount }]),
    );

    const weightedMap = new Map(weightedHouseData.map((h) =>
      [h.house, { totalPoints: h.totalPoints, memberCount: h.memberCount }]),
    );

    const allHouses = Object.keys(HOUSE_COLORS) as House[];

    const houses = allHouses.map((house) => {
      const weighted = weightedMap.get(house);
      const unweighted = unweightedMap.get(house);
      return {
        name: house,
        color: getHouseColor(house),
        rawPoints:   weighted?.totalPoints ?? 0,
        points:      weighted?.totalPoints ?? 0,
        memberCount: weighted?.memberCount ?? 0,
        unweightedPoints: unweighted?.unweightedPoints ?? 0,
        totalMemberCount: unweighted?.totalMemberCount ?? 0,
        rank: 1,
      };
    }).sort((a, b) => b.rawPoints - a.rawPoints);

    // Calculate ranks with ties (same points = same rank)
    houses.forEach((current, i) => {
      const prev = houses[i - 1];
      current.rank = prev?.rawPoints === current.rawPoints ? prev.rank : i + 1;
    });

    const mysteryMode = await isMysteryMode(req.query);

    // In mystery mode, strip every standings-revealing field from the payload so the
    // data is absent from the HTML source entirely, not merely hidden with CSS. Only
    // the house colour is kept (it draws the hourglass but reveals no placing), and the
    // order is shuffled so position can't hint at the ranking either.
    let displayHouses: { color: string }[] | typeof houses = houses;
    if (mysteryMode) {
      const pool = [...houses];
      const shuffled: { color: string }[] = [];
      while (pool.length > 0) {
        const [picked] = pool.splice(Math.floor(Math.random() * pool.length), 1);
        if (picked) shuffled.push({ color: picked.color });
      }
      displayHouses = shuffled;
    }

    const chartData = mysteryMode ? null : buildHousePaceChart(dailyEvents, monthStart);

    res.render("houses", {
      title: "House Standings",
      houses: displayHouses,
      mysteryMode,
      includeChartJs: !mysteryMode,
      chartData,
    });
  });
}
