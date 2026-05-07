import { HOUSE_COLORS } from "@/common/constants.ts";
import {
  getMonthStartDate,
  getWeightedHousePoints,
  getUnweightedHousePoints,
  getDailyUserPointEvents,
  db,
} from "@/db/db.ts";
import { buildHousePaceChart, getHouseColor } from "../utils.ts";
import type { Router } from "express";
import type { House } from "@/common/types.ts";
import { isHouseStandingsMysteryMode } from "@/common/mysteryMode.ts";

/**
 * Mystery mode: last 3 days of calendar month, but not within 2 days of reset
 * Can be bypassed with secret param, or forced with mystery=1 param
 */
function isMysteryMode(query: Record<string, unknown>, monthStart: Date): boolean {
  if (query["secret"] === process.env.MYSTERY_SECRET) return false;
  if (query["mystery"] === "1") return true;

  return isHouseStandingsMysteryMode(monthStart);
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

    const unweightedMap = new Map(unweightedHouseData.map((h) => [h.house, h]));

    const weightedMap = new Map(weightedHouseData.map((h) => [h.house, h]));

    const allHouses = Object.keys(HOUSE_COLORS) as House[];
    const unrankedHouseRank = weightedHouseData.length + 1;

    let houses = allHouses.map((house) => {
      const weighted = weightedMap.get(house);
      const unweighted = unweightedMap.get(house);
      return {
        name: house,
        color: getHouseColor(house),
        rawPoints:   weighted?.totalPoints ?? 0,
        points:      weighted?.totalPoints ?? 0,
        memberCount: weighted?.memberCount ?? 0,
        unweightedPoints: unweighted?.totalPoints ?? 0,
        totalMemberCount: unweighted?.memberCount ?? 0,
        rank: weighted?.rank ?? unrankedHouseRank,
      };
    }).sort((a, b) => b.rawPoints - a.rawPoints);

    const mysteryMode = isMysteryMode(req.query, monthStart);
    if (mysteryMode) {
      // Shuffle houses so order doesn't reveal ranking
      houses = houses.sort(() => Math.random() - 0.5);
    }

    const chartData = mysteryMode ? null : buildHousePaceChart(dailyEvents, monthStart);

    res.render("houses", {
      title: "House Standings",
      houses,
      mysteryMode,
      includeChartJs: !mysteryMode,
      chartData,
    });
  });
}
