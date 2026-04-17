import { HOUSE_COLORS, MIN_MONTHLY_POINTS_FOR_WEIGHTED } from "@/common/constants.ts";
import {
  getMonthStartDate,
  getWeightedHousePoints,
  getUnweightedHousePoints,
  getDailyUserPointEvents,
  db,
} from "@/db/db.ts";
import { getHouseColor } from "../utils.ts";
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

    const unweightedMap = new Map(
      unweightedHouseData.map((h) => [h.house, { unweightedPoints: h.totalPoints, totalMemberCount: h.memberCount }]),
    );

    const weightedMap = new Map(
      weightedHouseData.map((h) => [h.house, { totalPoints: h.totalPoints, memberCount: h.memberCount }]),
    );

    const allHouses = Object.keys(HOUSE_COLORS) as House[];

    let houses = allHouses
      .map((house) => {
        const weighted = weightedMap.get(house);
        const unweighted = unweightedMap.get(house);
        return {
          name: house,
          color: getHouseColor(house),
          rawPoints: weighted?.totalPoints ?? 0,
          points: weighted?.totalPoints ?? 0,
          memberCount: weighted?.memberCount ?? 0,
          unweightedPoints: unweighted?.unweightedPoints ?? 0,
          totalMemberCount: unweighted?.totalMemberCount ?? 0,
          rank: 1,
        };
      })
      .sort((a, b) => b.rawPoints - a.rawPoints);

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

/**
 * Build cumulative weighted-points series per house per day.
 * Weighted = truncated avg(cumulative monthlyPoints) over users with cumulative > threshold.
 */
function buildHousePaceChart(
  events: { discordId: string; house: House; day: string; points: number }[],
  monthStart: Date,
) {
  const start = dayjs(monthStart).startOf("day");
  const today = dayjs().startOf("day");
  const days = Math.max(1, today.diff(start, "day") + 1);

  const labels: string[] = [];
  const dayKeys: string[] = [];
  for (let i = 0; i < days; i++) {
    const d = start.add(i, "day");
    labels.push(d.format("MMM D"));
    dayKeys.push(d.format("YYYY-MM-DD"));
  }

  // user -> house, user -> day -> daily delta
  const userHouse = new Map<string, House>();
  const userDayDelta = new Map<string, Map<string, number>>();
  for (const e of events) {
    userHouse.set(e.discordId, e.house);
    let perDay = userDayDelta.get(e.discordId);
    if (!perDay) {
      perDay = new Map();
      userDayDelta.set(e.discordId, perDay);
    }
    perDay.set(e.day, (perDay.get(e.day) ?? 0) + e.points);
  }

  // Per-user cumulative series
  const userCumulative = new Map<string, number[]>();
  for (const [userId, perDay] of userDayDelta) {
    const series: number[] = [];
    let running = 0;
    for (const day of dayKeys) {
      running += perDay.get(day) ?? 0;
      series.push(running);
    }
    userCumulative.set(userId, series);
  }

  const houses = Object.keys(HOUSE_COLORS) as House[];
  const datasets = houses.map((house) => {
    const data: number[] = [];
    const userIds = [...userHouse].filter(([, h]) => h === house).map(([id]) => id);
    for (let i = 0; i < dayKeys.length; i++) {
      let sum = 0;
      let qualifying = 0;
      for (const id of userIds) {
        const val = userCumulative.get(id)?.[i] ?? 0;
        if (val > MIN_MONTHLY_POINTS_FOR_WEIGHTED) {
          sum += val;
          qualifying++;
        }
      }
      // Match PostgreSQL integer division used by getWeightedHousePoints.
      data.push(qualifying > 0 ? Math.trunc(sum / qualifying) : 0);
    }
    return { house, color: getHouseColor(house), data };
  });

  return { labels, datasets };
}
