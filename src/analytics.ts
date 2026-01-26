import { Router, type Router as RouterType } from "express";
import { db, getMonthStartDate, getVCEmoji } from "./db/db.ts";
import { userTable, voiceSessionTable, submissionTable } from "./db/schema.ts";
import { desc, eq, sql, and, gte, gt } from "drizzle-orm";
import type { House } from "./types.ts";
import { client } from "./client.ts";
import dayjs from "dayjs";
import { getYearFromMonthlyVoiceTime } from "./utils/yearRoleUtils.ts";
import { HOUSE_COLORS, YEAR_THRESHOLDS_HOURS } from "./utils/constants.ts";

export const analyticsRouter: RouterType = Router();

// Analytics-specific color overrides for dark background readability
const ANALYTICS_HOUSE_COLORS: Partial<Record<House, number>> = {
  Ravenclaw: 0x5b7fc7,
};

// Year badge/line colors
const YEAR_COLORS: Record<number, string> = {
  0: "#888888",
  1: "#cd8b62",
  2: "#d3d3d3",
  3: "#ffd700",
  4: "#5f9ea0",
  5: "#ba55d3",
  6: "#39ff14",
  7: "#ff4654",
};

function getHouseColor(house: House | null): string {
  if (!house) return "#888";
  const color = ANALYTICS_HOUSE_COLORS[house] ?? HOUSE_COLORS[house];
  return `#${color.toString(16).padStart(6, "0")}`;
}

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function cleanDisplayName(name: string, vcEmoji: string): string {
  return name
    .replace(/⚡\d+/g, "") // Remove streak
    .replace(new RegExp(` ${vcEmoji}`, "g"), "") // Remove VC emoji
    .trim();
}

// Check if we're in the last 3 days of the month (mystery mode)
function isInMysteryPeriod(): boolean {
  const now = dayjs();
  return now.date() > now.daysInMonth() - 3;
}

async function fetchDisplayNames(discordIds: string[]): Promise<Map<string, string>> {
  const guild = client.guilds.cache.get(process.env.GUILD_ID);
  if (!guild) return new Map();
  const members = await guild.members.fetch({ user: discordIds });
  const displayNames = new Map<string, string>();
  members.forEach((member, id) => displayNames.set(id, member.displayName));
  return displayNames;
}

// Home - House scoreboard
analyticsRouter.get("/", async (req, res) => {
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
  for (let i = 0; i < houses.length; i++) {
    const current = houses[i]!;
    const prev = houses[i - 1];
    if (prev && current.rawPoints === prev.rawPoints) {
      current.rank = prev.rank;
    } else {
      current.rank = i + 1;
    }
  }

  const mysteryMode = isInMysteryPeriod() || req.query["mystery"] === "1";
  if (mysteryMode) {
    // Shuffle houses so order doesn't reveal ranking
    houses = houses.sort(() => Math.random() - 0.5);
  }

  res.render("houses", { title: "House Standings", houses, mysteryMode });
});

analyticsRouter.get("/leaderboard", async (_req, res) => {
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
  const displayNames = await fetchDisplayNames(userData.map((u) => u.discordId));

  const users = userData.map((u, i) => ({
    rank: i + 1,
    discordId: u.discordId,
    displayName: cleanDisplayName(displayNames.get(u.discordId) ?? u.username, vcEmoji),
    house: u.house ?? "",
    houseColor: getHouseColor(u.house),
    monthlyPoints: u.monthlyPoints,
    voicePoints: Math.max(0, u.monthlyPoints - (todoPointsMap.get(u.discordId) ?? 0)),
    todoPoints: todoPointsMap.get(u.discordId) ?? 0,
    studyTime: formatTime(u.monthlyVoiceTime),
    voiceTimeSeconds: u.monthlyVoiceTime,
    yearRank: getYearFromMonthlyVoiceTime(u.monthlyVoiceTime) ?? 0,
    messageStreak: `${u.messageStreak}`,
  }));

  const houseColors = {
    Gryffindor: getHouseColor("Gryffindor"),
    Hufflepuff: getHouseColor("Hufflepuff"),
    Ravenclaw: getHouseColor("Ravenclaw"),
    Slytherin: getHouseColor("Slytherin"),
  };

  res.render("leaderboard", { title: "Leaderboard", users, houseColors, yearColors: YEAR_COLORS });
});

analyticsRouter.get("/user/:id", async (req, res) => {
  const userId = req.params.id;
  const [user] = await db.select().from(userTable).where(eq(userTable.discordId, userId));

  if (!user) {
    res.status(404).render("error", { title: "Not Found", message: "User not found" });
    return;
  }

  const [monthStart, vcEmoji] = await Promise.all([getMonthStartDate(), getVCEmoji()]);
  const displayNames = await fetchDisplayNames([userId]);
  const displayName = cleanDisplayName(displayNames.get(userId) ?? user.username, vcEmoji);

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
    messageStreak: `${user.messageStreak}`,
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

interface YearProgress {
  badge: string;
  badgeColor: string;
  percent: number;
  barStart: string;
  barEnd: string;
  barGlow: string;
  text: string;
  leftLabel: string;
  rightLabel: string;
  isMax: boolean;
}

interface BarColors {
  barStart: string;
  barEnd: string;
  barGlow: string;
}
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
