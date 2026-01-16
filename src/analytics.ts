import { Router, type Router as RouterType } from "express";
import { db, getMonthStartDate } from "./db/db.ts";
import { userTable, voiceSessionTable, submissionTable } from "./db/schema.ts";
import { desc, eq, sql, and, gte } from "drizzle-orm";
import type { House } from "./types.ts";
import { client } from "./client.ts";
import dayjs from "dayjs";
import { getYearFromMonthlyVoiceTime } from "./utils/yearRoleUtils.ts";
import { HOUSE_COLORS, YEAR_THRESHOLDS_HOURS } from "./utils/constants.ts";

export const analyticsRouter: RouterType = Router();

// Analytics-specific color overrides for dark background readability
const ANALYTICS_HOUSE_COLORS: Partial<Record<House, number>> = {
  Ravenclaw: 0x5b7fc7, // Lighter steel blue for dark background
};

const getHouseColor = (house: House | null) => {
  if (!house) return "#888";
  const color = ANALYTICS_HOUSE_COLORS[house] ?? HOUSE_COLORS[house];
  return `#${color.toString(16).padStart(6, "0")}`;
};

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// Home - House scoreboard
analyticsRouter.get("/", async (_req, res) => {
  const houseData = await db
    .select({
      house: userTable.house,
      totalPoints: sql<number>`sum(${userTable.monthlyPoints})`.as("total_points"),
      memberCount: sql<number>`count(*)`.as("member_count"),
    })
    .from(userTable)
    .where(sql`${userTable.house} IS NOT NULL`)
    .groupBy(userTable.house)
    .orderBy(desc(sql`total_points`));

  const houses = houseData
    .filter((h): h is typeof h & { house: House } => h.house !== null)
    .map((h) => ({
      name: h.house,
      color: getHouseColor(h.house),
      points: h.totalPoints.toLocaleString(),
      memberCount: h.memberCount,
    }));

  res.render("houses", { title: "House Standings", houses });
});

// Leaderboard
analyticsRouter.get("/leaderboard", async (_req, res) => {
  const userData = await db
    .select({
      username: userTable.username,
      discordId: userTable.discordId,
      house: userTable.house,
      monthlyPoints: userTable.monthlyPoints,
      monthlyVoiceTime: userTable.monthlyVoiceTime,
      messageStreak: userTable.messageStreak,
    })
    .from(userTable)
    .orderBy(desc(userTable.monthlyPoints))
    .limit(50);

  // Fetch display names from Discord
  const guild = client.guilds.cache.get(process.env.GUILD_ID);
  const displayNames = new Map<string, string>();
  if (guild) {
    const members = await guild.members.fetch({ user: userData.map((u) => u.discordId) });
    for (const [id, member] of members) {
      displayNames.set(id, member.displayName);
    }
  }

  const users = userData.map((u, i) => ({
    rank: i + 1,
    discordId: u.discordId,
    displayName: displayNames.get(u.discordId) ?? u.username,
    house: u.house,
    houseColor: getHouseColor(u.house),
    monthlyPoints: u.monthlyPoints,
    studyTime: formatTime(u.monthlyVoiceTime),
    messageStreak: `${u.messageStreak}`,
  }));

  res.render("leaderboard", { title: "Leaderboard", users });
});

// User detail
analyticsRouter.get("/user/:id", async (req, res) => {
  const { id } = req.params;

  const [user] = await db.select().from(userTable).where(eq(userTable.discordId, id));

  if (!user) {
    res.status(404).render("error", { title: "Not Found", message: "User not found" });
    return;
  }

  // Fetch display name from Discord
  const guild = client.guilds.cache.get(process.env.GUILD_ID);
  const member = guild ? await guild.members.fetch(id).catch(() => null) : null;
  const displayName = member?.displayName ?? user.username;

  const monthStart = await getMonthStartDate();
  const sessions = await db
    .select({
      joinedAt: voiceSessionTable.joinedAt,
      duration: voiceSessionTable.duration,
    })
    .from(voiceSessionTable)
    .where(
      and(
        eq(voiceSessionTable.discordId, id),
        eq(voiceSessionTable.isTracked, true),
        gte(voiceSessionTable.joinedAt, monthStart),
      ),
    )
    .orderBy(voiceSessionTable.joinedAt);

  const submissions = await db
    .select({
      submittedAt: submissionTable.submittedAt,
      points: submissionTable.points,
    })
    .from(submissionTable)
    .where(
      and(
        eq(submissionTable.discordId, id),
        eq(submissionTable.status, "APPROVED"),
        gte(submissionTable.submittedAt, monthStart),
      ),
    );

  const tz = user.timezone;

  // Aggregate sessions by day (in user's timezone)
  const dailyHours = new Map<string, number>();
  for (const s of sessions) {
    const day = dayjs(s.joinedAt).tz(tz).format("YYYY-MM-DD");
    dailyHours.set(day, (dailyHours.get(day) ?? 0) + (s.duration ?? 0) / 3600);
  }

  // Aggregate submissions by day (in user's timezone)
  const dailyTodoPoints = new Map<string, number>();
  for (const s of submissions) {
    const day = dayjs(s.submittedAt).tz(tz).format("YYYY-MM-DD");
    dailyTodoPoints.set(day, (dailyTodoPoints.get(day) ?? 0) + s.points);
  }

  // Build chart data
  const chartLabels: string[] = [];
  const chartHours: number[] = [];
  const chartTodoPoints: number[] = [];
  let cumulative = 0;
  const now = dayjs().tz(tz);
  const daysInPeriod = now.diff(dayjs(monthStart).tz(tz), "day") + 1;
  for (let i = daysInPeriod - 1; i >= 0; i--) {
    const day = now.subtract(i, "day").format("YYYY-MM-DD");
    const label = now.subtract(i, "day").format("MMM D");
    cumulative += dailyHours.get(day) ?? 0;
    chartLabels.push(label);
    chartHours.push(Math.round(cumulative * 10) / 10);
    chartTodoPoints.push(dailyTodoPoints.get(day) ?? 0);
  }

  const houseColor = getHouseColor(user.house);

  // Year rank progress calculation
  const yearProgress = calculateYearProgress(user.monthlyVoiceTime);

  res.render("user", {
    title: displayName,
    includeChartJs: true,
    displayName,
    house: user.house,
    houseColor,
    monthlyPoints: user.monthlyPoints,
    monthlyStudy: formatTime(user.monthlyVoiceTime),
    messageStreak: `${user.messageStreak}`,
    totalPoints: user.totalPoints,
    totalStudy: formatTime(user.totalVoiceTime),
    yearProgress,
    chartLabels,
    chartHours,
    chartTodoPoints,
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

function calculateYearProgress(monthlyVoiceTime: number): YearProgress {
  const currentYear = getYearFromMonthlyVoiceTime(monthlyVoiceTime);
  const currentHours = monthlyVoiceTime / 3600;

  if (currentYear === null) {
    const nextThreshold = YEAR_THRESHOLDS_HOURS[0];
    const progress = Math.min((currentHours / nextThreshold) * 100, 100);
    return {
      badge: "Year 0",
      badgeColor: "#888",
      percent: progress,
      barStart: "#4a4a4a",
      barEnd: "#6a6a6a",
      barGlow: "#555",
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
      barStart: "#ffd700",
      barEnd: "#ffec8b",
      barGlow: "#ffd700",
      text: `${currentHours.toFixed(1)}h - Maximum Rank!`,
      leftLabel: `${YEAR_THRESHOLDS_HOURS[6]}h`,
      rightLabel: "Maximum rank achieved",
      isMax: true,
    };
  }

  // Years 1-6
  const thresholdIndex = (currentYear - 1) as 0 | 1 | 2 | 3 | 4 | 5;
  const currentThreshold = YEAR_THRESHOLDS_HOURS[thresholdIndex];
  const nextThreshold = YEAR_THRESHOLDS_HOURS[currentYear];
  const progress = ((currentHours - currentThreshold) / (nextThreshold - currentThreshold)) * 100;

  const barColors: Record<1 | 2 | 3 | 4 | 5 | 6, { start: string; end: string; glow: string }> = {
    1: { start: "#8b4513", end: "#a0522d", glow: "#8b4513" },
    2: { start: "#cd7f32", end: "#daa520", glow: "#cd7f32" },
    3: { start: "#c0c0c0", end: "#d3d3d3", glow: "#c0c0c0" },
    4: { start: "#ffd700", end: "#ffec8b", glow: "#ffd700" },
    5: { start: "#00ced1", end: "#40e0d0", glow: "#00ced1" },
    6: { start: "#9370db", end: "#ba55d3", glow: "#9370db" },
  };
  const colors = barColors[currentYear];

  return {
    badge: `Year ${currentYear}`,
    badgeColor: colors.start,
    percent: progress,
    barStart: colors.start,
    barEnd: colors.end,
    barGlow: colors.glow,
    text: `${currentHours.toFixed(1)}h / ${nextThreshold}h`,
    leftLabel: `${currentThreshold}h`,
    rightLabel: `Next: Year ${currentYear + 1} (${nextThreshold}h)`,
    isMax: false,
  };
}
