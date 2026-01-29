import { db, getMonthStartDate, getVCEmoji } from "@/db/db.ts";
import { submissionTable, userTable } from "@/db/schema.ts";
import { and, eq, gt, gte } from "drizzle-orm/sql/expressions/conditions";
import { desc } from "drizzle-orm/sql/expressions/select";
import { sql } from "drizzle-orm/sql/sql";
import type { Router } from "express";
import { cleanDisplayName, fetchMemberInfo, formatTime, getHouseColor } from "../utils.ts";
import { getYearFromMonthlyVoiceTime } from "@/discord/utils/yearRoleUtils.ts";
import { YEAR_COLORS } from "@/common/constants.ts";

export default function registerLeaderboardRoute(app: Router) {
  app.get("/leaderboard", async (_req, res) => {
    const monthStart = await getMonthStartDate();

    const [todoPointsData, userData, vcEmoji] = await Promise.all([
      db
        .select({
          discordId: submissionTable.discordId,
          todoPoints: sql<number>`COALESCE(sum(${submissionTable.points}), 0)`,
        })
        .from(submissionTable)
        .where(and(gte(submissionTable.submittedAt, monthStart), eq(submissionTable.status, "APPROVED")))
        .groupBy(submissionTable.discordId),
      db
        .select({
          username: userTable.username,
          discordId: userTable.discordId,
          house: userTable.house,
          monthlyPoints: userTable.monthlyPoints,
          monthlyVoiceTime: userTable.monthlyVoiceTime,
          messageStreak: userTable.messageStreak,
        })
        .from(userTable)
        .where(gt(userTable.monthlyPoints, 0))
        .orderBy(desc(userTable.monthlyPoints)),
      getVCEmoji(),
    ]);

    const todoPointsMap = new Map(todoPointsData.map((t) => [t.discordId, t.todoPoints]));
    const memberInfo = await fetchMemberInfo(userData.map((u) => u.discordId));

    const users = userData.map((u, i) => {
      const info = memberInfo.get(u.discordId);
      return {
        rank: i + 1,
        discordId: u.discordId,
        displayName: cleanDisplayName(info?.displayName ?? u.username, vcEmoji),
        house: u.house ?? "",
        houseColor: getHouseColor(u.house),
        monthlyPoints: u.monthlyPoints,
        voicePoints: Math.max(0, u.monthlyPoints - (todoPointsMap.get(u.discordId) ?? 0)),
        todoPoints: todoPointsMap.get(u.discordId) ?? 0,
        studyTime: formatTime(u.monthlyVoiceTime),
        voiceTimeSeconds: u.monthlyVoiceTime,
        yearRank: getYearFromMonthlyVoiceTime(u.monthlyVoiceTime) ?? 0,
        messageStreak: info?.isProfessor ? "-" : `${u.messageStreak}`,
      };
    });

    const houseColors = {
      Gryffindor: getHouseColor("Gryffindor"),
      Hufflepuff: getHouseColor("Hufflepuff"),
      Ravenclaw: getHouseColor("Ravenclaw"),
      Slytherin: getHouseColor("Slytherin"),
    };

    res.render("leaderboard", { title: "Leaderboard", users, houseColors, yearColors: YEAR_COLORS });
  });
}
