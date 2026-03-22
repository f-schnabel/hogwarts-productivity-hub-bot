import { HOUSE_COLORS } from "@/common/constants.ts";
import { db, getVCEmoji } from "@/db/db.ts";
import { houseCupEntryTable, houseCupMonthTable, userTable } from "@/db/schema.ts";
import { desc, gt, inArray, sql } from "drizzle-orm";
import type { Router } from "express";
import { cleanDisplayName, fetchMemberInfo, getHouseColor } from "../utils.ts";
import type { House } from "@/common/types.ts";

const ALL_HOUSES = Object.keys(HOUSE_COLORS) as House[];

type CupMonth = typeof houseCupMonthTable.$inferSelect;
type CupEntry = typeof houseCupEntryTable.$inferSelect;

export default function registerHallOfFameRoute(app: Router) {
  app.get("/hall-of-fame", async (_req, res) => {
    const [cupMonths, topStudents, allTimeHouseData] = await Promise.all([
      db
        .select()
        .from(houseCupMonthTable)
        .orderBy(desc(houseCupMonthTable.createdAt))
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
      Ravenclaw: getHouseColor("Ravenclaw"),
      Slytherin: getHouseColor("Slytherin"),
    };

    res.render("hallOfFame", {
      title: "Hall of Fame",
      cupWinCards,
      timeline,
      students,
      allTimeHouses,
      houseColors,
    });
  });
}
