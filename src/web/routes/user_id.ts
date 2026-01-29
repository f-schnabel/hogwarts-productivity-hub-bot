import { YEAR_COLORS, YEAR_THRESHOLDS_HOURS } from "@/common/constants.ts";
import { db, getMonthStartDate, getVCEmoji } from "@/db/db.ts";
import { submissionTable, userTable, voiceSessionTable } from "@/db/schema.ts";
import { and, eq, gte } from "drizzle-orm";
import type { Router } from "express";
import { cleanDisplayName, fetchMemberInfo, formatTime, getHouseColor } from "../utils.ts";
import dayjs from "dayjs";
import { getYearFromMonthlyVoiceTime } from "@/discord/utils/yearRoleUtils.ts";
import type { BarColors, YearProgress } from "@/common/types.ts";

const BAR_COLORS: Record<0 | 1 | 2 | 3 | 4 | 5 | 6 | 7, BarColors> = {
  0: { barStart: "#4a4a4a", barEnd: "#6a6a6a", barGlow: "#555" },
  1: { barStart: "#8b4513", barEnd: "#a0522d", barGlow: "#8b4513" },
  2: { barStart: "#cd7f32", barEnd: "#daa520", barGlow: "#cd7f32" },
  3: { barStart: "#c0c0c0", barEnd: "#d3d3d3", barGlow: "#c0c0c0" },
  4: { barStart: "#ffd700", barEnd: "#ffec8b", barGlow: "#ffd700" },
  5: { barStart: "#00ced1", barEnd: "#40e0d0", barGlow: "#00ced1" },
  6: { barStart: "#9370db", barEnd: "#ba55d3", barGlow: "#9370db" },
  7: { barStart: "#ffd700", barEnd: "#ffec8b", barGlow: "#ffd700" },
};

function calculateYearProgress(monthlyVoiceTime: number): YearProgress {
  const currentYear = (getYearFromMonthlyVoiceTime(monthlyVoiceTime) ?? 0) as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
  const currentHours = monthlyVoiceTime / 3600;
  const colors = BAR_COLORS[currentYear];

  if (currentYear === 0) {
    const nextThreshold = YEAR_THRESHOLDS_HOURS[0];
    return {
      badge: "Year 0",
      badgeColor: "#888",
      percent: Math.min((currentHours / nextThreshold) * 100, 100),
      ...colors,
      text: `${currentHours.toFixed(1)}h / ${nextThreshold}h`,
      leftLabel: "0h",
      rightLabel: `Next: Year 1 (${nextThreshold}h)`,
      isMax: false,
    };
  }

  if (currentYear === 7) {
    return {
      badge: "Year 7",
      badgeColor: "#ffd700",
      percent: 100,
      ...colors,
      text: `${currentHours.toFixed(1)}h - Maximum Rank!`,
      leftLabel: `${YEAR_THRESHOLDS_HOURS[6]}h`,
      rightLabel: "Maximum rank achieved",
      isMax: true,
    };
  }

  const prevThreshold = YEAR_THRESHOLDS_HOURS[(currentYear - 1) as 0 | 1 | 2 | 3 | 4 | 5];
  const nextThreshold = YEAR_THRESHOLDS_HOURS[currentYear];

  return {
    badge: `Year ${currentYear}`,
    badgeColor: colors.barStart,
    percent: ((currentHours - prevThreshold) / (nextThreshold - prevThreshold)) * 100,
    ...colors,
    text: `${currentHours.toFixed(1)}h / ${nextThreshold}h`,
    leftLabel: `${prevThreshold}h`,
    rightLabel: `Next: Year ${currentYear + 1} (${nextThreshold}h)`,
    isMax: false,
  };
}

export default function registerUserIdRoute(app: Router) {
  app.get("/user/:id", async (req, res) => {
    const userId = req.params.id;
    const [user] = await db.select().from(userTable).where(eq(userTable.discordId, userId));

    if (!user) {
      res.status(404).render("error", { title: "Not Found", message: "User not found" });
      return;
    }
    const [monthStart, vcEmoji] = await Promise.all([getMonthStartDate(), getVCEmoji()]);
    const memberInfo = await fetchMemberInfo([userId]);
    const info = memberInfo.get(userId);
    const displayName = cleanDisplayName(info?.displayName ?? user.username, vcEmoji);

    const [sessions, submissions] = await Promise.all([
      db
        .select({ joinedAt: voiceSessionTable.joinedAt, duration: voiceSessionTable.duration })
        .from(voiceSessionTable)
        .where(
          and(
            eq(voiceSessionTable.discordId, userId),
            eq(voiceSessionTable.isTracked, true),
            gte(voiceSessionTable.joinedAt, monthStart),
          ),
        )
        .orderBy(voiceSessionTable.joinedAt),
      db
        .select({ submittedAt: submissionTable.submittedAt, points: submissionTable.points })
        .from(submissionTable)
        .where(
          and(
            eq(submissionTable.discordId, userId),
            eq(submissionTable.status, "APPROVED"),
            gte(submissionTable.submittedAt, monthStart),
          ),
        ),
    ]);

    const tz = user.timezone;
    const dailyHours = new Map<string, number>();
    const dailyTodoPoints = new Map<string, number>();

    for (const s of sessions) {
      const day = dayjs(s.joinedAt).tz(tz).format("YYYY-MM-DD");
      dailyHours.set(day, (dailyHours.get(day) ?? 0) + (s.duration ?? 0) / 3600);
    }
    for (const s of submissions) {
      const day = dayjs(s.submittedAt).tz(tz).format("YYYY-MM-DD");
      dailyTodoPoints.set(day, (dailyTodoPoints.get(day) ?? 0) + s.points);
    }

    const now = dayjs().tz(tz);
    const daysInPeriod = now.diff(dayjs(monthStart).tz(tz), "day") + 1;
    const chartLabels: string[] = [];
    const chartHours: number[] = [];
    const chartTodoPoints: number[] = [];
    let cumulative = 0;

    for (let i = daysInPeriod - 1; i >= 0; i--) {
      const dayDate = now.subtract(i, "day");
      const day = dayDate.format("YYYY-MM-DD");
      cumulative += dailyHours.get(day) ?? 0;
      chartLabels.push(dayDate.format("MMM D"));
      chartHours.push(Math.round(cumulative * 10) / 10);
      chartTodoPoints.push(dailyTodoPoints.get(day) ?? 0);
    }

    const yearProgress = calculateYearProgress(user.monthlyVoiceTime);
    const yearLines = YEAR_THRESHOLDS_HOURS.map((hours, i) => ({
      hours,
      label: `Year ${i + 1}`,
      color: YEAR_COLORS[i + 1] ?? "#888",
    }));

    const currentYear = getYearFromMonthlyVoiceTime(user.monthlyVoiceTime);
    const nextYearIndex = (currentYear ?? 0) as 0 | 1 | 2 | 3 | 4 | 5 | 6;
    const chartYMax = nextYearIndex < 7 ? YEAR_THRESHOLDS_HOURS[nextYearIndex] + 5 : null;

    res.render("user", {
      title: displayName,
      includeChartJs: true,
      displayName,
      house: user.house,
      houseColor: getHouseColor(user.house),
      monthlyPoints: user.monthlyPoints,
      monthlyStudy: formatTime(user.monthlyVoiceTime),
      messageStreak: info?.isProfessor ? "-" : `${user.messageStreak}`,
      totalPoints: user.totalPoints,
      totalStudy: formatTime(user.totalVoiceTime),
      yearProgress,
      chartLabels,
      chartHours,
      chartTodoPoints,
      yearLines,
      chartYMax,
    });
  });
}
