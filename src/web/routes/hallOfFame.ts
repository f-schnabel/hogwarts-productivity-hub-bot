import { HOUSE_COLORS } from "@/common/constants.ts";
import { db, getDailyUserPointEvents, getVCEmoji } from "@/db/db.ts";
import { houseCupEntryTable, houseCupMonthTable, userTable } from "@/db/schema.ts";
import { desc, eq, gt, inArray, sql } from "drizzle-orm";
import type { Router } from "express";
import { buildHousePaceChart, cleanDisplayName, fetchMemberInfo, getHouseColor } from "../utils.ts";
import type { House } from "@/common/types.ts";
import dayjs from "dayjs";

const ALL_HOUSES = Object.keys(HOUSE_COLORS) as House[];

type CupMonth = typeof houseCupMonthTable.$inferSelect;
type CupEntry = typeof houseCupEntryTable.$inferSelect;

export default function registerHallOfFameRoute(app: Router) {
  // Cup detail page — historical month rendered like the index hourglass page
  app.get("/cup/:month", async (req, res) => {
    const month = req.params.month;
    const [cupMonth] = await db.select().from(houseCupMonthTable).where(eq(houseCupMonthTable.month, month));

    if (!cupMonth) {
      res.status(404).render("hallOfFame", {
        title: "Not Found",
        cupWinCards: [],
        timeline: [],
        students: [],
        allTimeHouses: [],
        houseColors: {},
      });
      return;
    }

    const byHouse = await db
      .select()
      .from(houseCupEntryTable)
      .where(eq(houseCupEntryTable.monthId, cupMonth.id))
      .then((entries) => new Map(entries.map((e) => [e.house, e])));

    const houses = ALL_HOUSES.map((house) => {
      const entry = byHouse.get(house);
      return {
        name: house,
        color: getHouseColor(house),
        rawPoints:        entry?.weightedPoints ?? 0,
        points:           entry?.weightedPoints ?? 0,
        memberCount:      entry?.qualifyingCount ?? 0,
        unweightedPoints: entry?.rawPoints ?? 0,
        totalMemberCount: entry?.memberCount ?? 0,
        rank: 1,
      };
    }).sort((a, b) => b.rawPoints - a.rawPoints);

    houses.forEach((current, i) => {
      const prev = houses[i - 1];
      current.rank = prev?.rawPoints === current.rawPoints ? prev.rank : i + 1;
    });

    const monthStart = dayjs(cupMonth.month).startOf("month").toDate();
    const dailyEvents = await getDailyUserPointEvents(db, monthStart);
    const chartData = buildHousePaceChart(dailyEvents, monthStart);

    res.render("houses", {
      title: "House Cup Standings",
      subtitle: month,
      houses,
      mysteryMode: false,
      includeChartJs: true,
      chartData,
    });
  });

  app.get("/hall-of-fame", async (_req, res) => {
    const [cupMonths, topStudents, allTimeHouseData] = await Promise.all([
      db
        .select()
        .from(houseCupMonthTable)
        .orderBy(desc(houseCupMonthTable.month))
        .catch((): CupMonth[] => []),
      db
        .select({
          discordId: userTable.discordId,
          username: userTable.username,
          house: userTable.house,
          totalPoints: userTable.totalPoints,
        })
        .from(userTable)
        .where(gt(userTable.totalPoints, 0))
        .orderBy(desc(userTable.totalPoints))
        .limit(25),
      db
        .select({
          house: userTable.house,
          totalPoints: sql<number>`sum(${userTable.totalPoints})`.as("total_points"),
        })
        .from(userTable)
        .where(sql`${userTable.house} IS NOT NULL`)
        .groupBy(userTable.house)
        .orderBy(desc(sql`total_points`)),
    ]);

    // Fetch entries for all months
    const monthIds = cupMonths.map((m) => m.id);
    const cupEntries: CupEntry[] =
      monthIds.length > 0
        ? await db.select().from(houseCupEntryTable).where(inArray(houseCupEntryTable.monthId, monthIds))
        : [];
    const entriesByMonth = Map.groupBy(cupEntries, (e) => e.monthId);

    // Count cups won per house
    const cupWins: Record<House, number> = { Gryffindor: 0, Hufflepuff: 0, Ravenclaw: 0, Slytherin: 0 };
    for (const cup of cupMonths) {
      cupWins[cup.winner]++;
    }

    const cupWinCards = ALL_HOUSES.map((house) => ({
      name: house,
      color: getHouseColor(house),
      wins: cupWins[house],
    })).sort((a, b) => b.wins - a.wins);

    // Cup history timeline
    const timeline = cupMonths.map((cup) => {
      const entries = entriesByMonth.get(cup.id) ?? [];
      const byHouse = new Map(entries.map((e) => [e.house, e]));
      return {
        month: cup.month,
        winner: cup.winner,
        winnerColor: getHouseColor(cup.winner),
        houses: ALL_HOUSES.map((house) => ({
          house,
          weightedPoints: byHouse.get(house)?.weightedPoints ?? 0,
          isWinner: house === cup.winner,
        })),
      };
    });

    // Top 25 students — resolve display names via Discord
    const [memberInfo, vcEmoji] = await Promise.all([
      fetchMemberInfo(topStudents.map((u) => u.discordId)),
      getVCEmoji(),
    ]);
    const students = topStudents.map((u, i) => {
      const info = memberInfo.get(u.discordId);
      return {
        rank: i + 1,
        discordId: u.discordId,
        displayName: cleanDisplayName(info?.displayName ?? u.username, vcEmoji),
        house: u.house ?? "",
        houseColor: getHouseColor(u.house),
        totalPoints: u.totalPoints,
      };
    });

    // All-time house points
    const allTimeHouses = ALL_HOUSES.map((house) => {
      const data = allTimeHouseData.find((h) => h.house === house);
      return {
        name: house,
        color: getHouseColor(house),
        totalPoints: data?.totalPoints ?? 0,
      };
    }).sort((a, b) => b.totalPoints - a.totalPoints);

    const houseColors = {
      Gryffindor: getHouseColor("Gryffindor"),
      Hufflepuff: getHouseColor("Hufflepuff"),
      Ravenclaw:  getHouseColor("Ravenclaw"),
      Slytherin:  getHouseColor("Slytherin"),
    };

    // Chart data
    const chartCupMonths =
      timeline.length > 0
        ? timeline.map((t) => ({
            month: t.month,
            houses: t.houses.map((h) => ({
              house: h.house,
              points: h.weightedPoints,
              isWinner: h.isWinner,
            })),
          }))
        : null;
    const chartTop10 = students.slice(0, 10).map((s) => ({
      label: s.displayName,
      value: s.totalPoints,
      color: s.houseColor,
    }));

    res.render("hallOfFame", {
      title: "Hall of Fame",
      cupWinCards,
      timeline,
      students,
      allTimeHouses,
      houseColors,
      includeChartJs: true,
      chartCupMonths,
      chartTop10,
    });
  });
}
