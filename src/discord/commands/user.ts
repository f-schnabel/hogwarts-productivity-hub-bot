import { SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";
import dayjs from "dayjs";
import { db, getMonthStartDate } from "@/db/db.ts";
import { submissionTable, userTable, voiceSessionTable } from "@/db/schema.ts";
import { and, asc, eq, gte, isNull } from "drizzle-orm";
import { calculatePoints } from "@/services/pointsService.ts";
import { formatDuration, errorReply, inGuild, requireRole } from "@/discord/utils/interactionUtils.ts";
import { BOT_COLORS, Role, YEAR_THRESHOLDS_HOURS } from "@/common/constants.ts";
import { getYearFromMonthlyVoiceTime } from "@/discord/utils/yearRoleUtils.ts";
import type { CommandOptions } from "@/common/types.ts";

import { stripIndent } from "common-tags";
import assert from "node:assert";

export default {
  data: new SlashCommandBuilder()
    .setName("user")
    .setDescription("Manage your timezone settings for accurate daily/monthly resets")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("time")
        .setDescription("View a user's clock in their timezone")
        .addUserOption((option) =>
          option.setName("user").setDescription("The user to view the clock for").setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("points")
        .setDescription("View breakdown of a user's monthly points")
        .addUserOption((option) =>
          option.setName("user").setDescription("The user to view points for").setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("points-detailed")
        .setDescription("View all individual sessions this month (OWNER/PREFECT only)")
        .addUserOption((option) =>
          option.setName("user").setDescription("The user to view sessions for").setRequired(true),
        ),
    ),

  async execute(interaction: ChatInputCommandInteraction, { opId }: CommandOptions) {
    switch (interaction.options.getSubcommand()) {
      case "time":
        await time(interaction, opId);
        break;
      case "points":
        await points(interaction, opId);
        break;
      case "points-detailed":
        await pointsDetailed(interaction, opId);
        break;
      default:
        await errorReply(
          opId,
          interaction,
          "Invalid Subcommand",
          "Please use `/user time`, `/user points`, or `/user points-detailed`.",
        );
        return;
    }
  },
};

async function time(interaction: ChatInputCommandInteraction, opId: string) {
  const user = interaction.options.getUser("user", true);
  const [userData] = await db
    .select({ timezone: userTable.timezone })
    .from(userTable)
    .where(eq(userTable.discordId, user.id));

  if (!userData?.timezone) {
    await errorReply(opId, interaction, "Timezone Not Set", `${user.username} has not set their timezone.`);
    return;
  }
  await interaction.reply(
    `${user.displayName}'s current time is ${dayjs().tz(userData.timezone).format("YYYY-MM-DD hh:mm:ss A")}`,
  );
}

async function points(interaction: ChatInputCommandInteraction, opId: string) {
  if (!inGuild(interaction, opId)) return;
  await interaction.deferReply();

  const user = interaction.options.getUser("user", true);
  const [userData] = await db.select().from(userTable).where(eq(userTable.discordId, user.id));

  if (!userData) {
    await errorReply(opId, interaction, "User Not Found", `${user.username} is not registered.`, { deferred: true });
    return;
  }

  const startOfMonth = await getMonthStartDate();

  // Get approved submissions this month
  const submissions = await db
    .select({
      points: submissionTable.points,
      submittedAt: submissionTable.submittedAt,
    })
    .from(submissionTable)
    .where(
      and(
        eq(submissionTable.discordId, user.id),
        eq(submissionTable.status, "APPROVED"),
        gte(submissionTable.submittedAt, startOfMonth),
      ),
    );

  // Get tracked voice sessions this month, ordered by joinedAt for merging
  const voiceSessions = await db
    .select({
      duration: voiceSessionTable.duration,
      channelName: voiceSessionTable.channelName,
      joinedAt: voiceSessionTable.joinedAt,
      leftAt: voiceSessionTable.leftAt,
      points: voiceSessionTable.points,
    })
    .from(voiceSessionTable)
    .where(
      and(
        eq(voiceSessionTable.discordId, user.id),
        eq(voiceSessionTable.isTracked, true),
        gte(voiceSessionTable.leftAt, startOfMonth),
      ),
    )
    .orderBy(asc(voiceSessionTable.joinedAt));

  // Get active (ongoing) voice session if any
  const [activeSession] = await db
    .select({
      channelName: voiceSessionTable.channelName,
      joinedAt: voiceSessionTable.joinedAt,
    })
    .from(voiceSessionTable)
    .where(
      and(
        eq(voiceSessionTable.discordId, user.id),
        eq(voiceSessionTable.isTracked, false),
        isNull(voiceSessionTable.leftAt),
      ),
    );

  // Calculate active session duration and points (without saving)
  let activeSessionDuration = 0;
  let activeSessionPoints = 0;
  if (activeSession) {
    activeSessionDuration = Math.floor((Date.now() - activeSession.joinedAt.getTime()) / 1000);
    activeSessionPoints = calculatePoints(userData.dailyVoiceTime, userData.dailyVoiceTime + activeSessionDuration);
  }

  const totalSubmissionPoints = submissions.reduce((sum, s) => sum + s.points, 0);
  const totalVoiceSeconds = voiceSessions.reduce((sum, s) => sum + (s.duration ?? 0), 0);

  // Group by day in user's timezone
  const tz = userData.timezone;
  const dailyData = new Map<
    string,
    { voiceSeconds: number; voicePoints: number; submissionPoints: number; submissionCount: number }
  >();

  for (const session of voiceSessions) {
    const day = dayjs(session.joinedAt).tz(tz).format("YYYY-MM-DD");
    const existing = dailyData.get(day) ?? { voiceSeconds: 0, voicePoints: 0, submissionPoints: 0, submissionCount: 0 };
    existing.voiceSeconds += session.duration ?? 0;
    existing.voicePoints += session.points ?? 0;
    dailyData.set(day, existing);
  }

  for (const submission of submissions) {
    const day = dayjs(submission.submittedAt).tz(tz).format("YYYY-MM-DD");
    const existing = dailyData.get(day) ?? { voiceSeconds: 0, voicePoints: 0, submissionPoints: 0, submissionCount: 0 };
    existing.submissionPoints += submission.points;
    existing.submissionCount += 1;
    dailyData.set(day, existing);
  }

  // Add active session to daily data (blend in with completed sessions)
  if (activeSession) {
    const day = dayjs(activeSession.joinedAt).tz(tz).format("YYYY-MM-DD");
    const existing = dailyData.get(day) ?? { voiceSeconds: 0, voicePoints: 0, submissionPoints: 0, submissionCount: 0 };
    existing.voiceSeconds += activeSessionDuration;
    existing.voicePoints += activeSessionPoints;
    dailyData.set(day, existing);
  }

  // Build activity lines: daily for current week, weekly aggregates for previous weeks
  const now = dayjs();
  const currentWeekStart = now.startOf("week");

  // Separate current week days vs previous weeks
  const currentWeekDays: [
    string,
    { voiceSeconds: number; voicePoints: number; submissionPoints: number; submissionCount: number },
  ][] = [];
  const weeklyData = new Map<
    string,
    { voiceSeconds: number; voicePoints: number; submissionPoints: number; submissionCount: number }
  >();

  for (const [day, data] of dailyData.entries()) {
    const dayDate = dayjs(day);
    if (!dayDate.isBefore(currentWeekStart, "day")) {
      currentWeekDays.push([day, data]);
    } else {
      // Group by week start (Sunday)
      const weekStart = dayDate.startOf("week").isAfter(startOfMonth)
        ? dayDate.startOf("week").format("YYYY-MM-DD")
        : dayjs(startOfMonth).format("YYYY-MM-DD");
      const existing = weeklyData.get(weekStart) ?? {
        voiceSeconds: 0,
        voicePoints: 0,
        submissionPoints: 0,
        submissionCount: 0,
      };
      existing.voiceSeconds += data.voiceSeconds;
      existing.voicePoints += data.voicePoints;
      existing.submissionPoints += data.submissionPoints;
      existing.submissionCount += data.submissionCount;
      weeklyData.set(weekStart, existing);
    }
  }

  const formatLine = (
    label: string,
    data: { voiceSeconds: number; voicePoints: number; submissionPoints: number; submissionCount: number },
  ) => {
    const total = data.voicePoints + data.submissionPoints;
    const parts: string[] = [];
    if (data.voiceSeconds > 0) parts.push(`${formatDuration(data.voiceSeconds)} (${data.voicePoints} pt)`);
    if (data.submissionPoints > 0) {
      const todoLabel = data.submissionCount === 1 ? "To-Do List" : "To-Do Lists";
      parts.push(`${todoLabel} (${data.submissionPoints} pt)`);
    }
    return `• ${label}: **${total} pt** = ${parts.join(" + ")}`;
  };

  // Build weekly lines (sorted by week start)
  const weeklyLines = [...weeklyData.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([weekStart, data]) => {
      const start = dayjs(weekStart);
      const end = start.endOf("week");
      const endFormat = start.month() !== end.month() ? "MMM D" : "D";
      const label = `${start.format("MMM D")} - ${end.format(endFormat)}`;
      return formatLine(label, data);
    });

  // Build daily lines for current week (sorted by day)
  const dailyLines = currentWeekDays
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, data]) => formatLine(dayjs(day).format("MMM D"), data));

  const activityLines = [...weeklyLines, ...dailyLines].join("\n") || "None";

  // Year progress calculation
  const currentYear = getYearFromMonthlyVoiceTime(userData.monthlyVoiceTime);
  const currentHours = userData.monthlyVoiceTime / 3600;
  let yearProgressValue: string;
  const width = 20;

  if (currentYear === null) {
    const nextThreshold = YEAR_THRESHOLDS_HOURS[0];
    const progress = Math.min(currentHours / nextThreshold, 1);
    const filled = Math.round(progress * width);
    const bar = "▓".repeat(filled) + "░".repeat(width - filled);
    yearProgressValue = `**Year 0** (0h - ${nextThreshold}h)\n${bar} ${currentHours.toFixed(0)}/${nextThreshold}h\nNext rank: **Year 1** (${nextThreshold}h - ${YEAR_THRESHOLDS_HOURS[1]}h)`;
  } else if (currentYear === 7) {
    yearProgressValue = `**Year 7** (${YEAR_THRESHOLDS_HOURS[6]}h+)\n${"▓".repeat(width)} (${currentHours.toFixed(0)}h)\nMaximum rank achieved`;
  } else {
    const nextThreshold = YEAR_THRESHOLDS_HOURS[currentYear];
    const currentThreshold = YEAR_THRESHOLDS_HOURS[currentYear - 1];
    assert(currentThreshold !== undefined, "Current threshold should be defined for years >= 1");
    const progress = (currentHours - currentThreshold) / (nextThreshold - currentThreshold);
    const filled = Math.round(progress * width);
    const bar = "▓".repeat(filled) + "░".repeat(width - filled);
    const nextNextThreshold = YEAR_THRESHOLDS_HOURS[currentYear + 1];
    const nextRankRange =
      nextNextThreshold !== undefined ? `${nextThreshold}h - ${nextNextThreshold}h` : `${nextThreshold}h+`;
    yearProgressValue = `**Year ${currentYear}** (${currentThreshold}h - ${nextThreshold}h)\n${bar} ${currentHours.toFixed(0)}/${nextThreshold}h\nNext rank: **Year ${currentYear + 1}** (${nextRankRange})`;
  }

  await interaction.editReply({
    embeds: [
      {
        color: BOT_COLORS.INFO,
        title: "Monthly Points Breakdown",
        description: `Viewing monthly points for ${user.toString()}`,
        thumbnail: {
          url: user.displayAvatarURL(),
        },
        fields: [
          {
            name: `Activity (${dayjs().tz(tz).format("z")})`,
            value: activityLines,
          },
          {
            name: "Monthly Totals",
            value: stripIndent`
              Study: ${formatDuration(totalVoiceSeconds)}${activeSessionDuration > 0 ? ` (+${formatDuration(activeSessionDuration)} pending)` : ""}
              Submissions: ${totalSubmissionPoints} pts
              **Total: ${userData.monthlyPoints} pts**${activeSessionPoints > 0 ? ` (+${activeSessionPoints} pending)` : ""}`,
          },
          {
            name: "Year Progress",
            value: yearProgressValue,
          },
        ],
        footer: { text: `Month: ${dayjs().format("MMMM YYYY")}` },
      },
    ],
    allowedMentions: { users: [] },
  });
}

// Merge consecutive sessions (same channel, leftAt == joinedAt of next, not at midnight boundary)
interface MergedSession {
  channelName: string | null;
  joinedAt: Date;
  leftAt: Date | null;
  duration: number;
}

async function pointsDetailed(interaction: ChatInputCommandInteraction, opId: string) {
  if (!inGuild(interaction, opId) || !requireRole(interaction, opId, Role.OWNER | Role.PREFECT)) return;
  await interaction.deferReply();

  const user = interaction.options.getUser("user", true);
  const [userData] = await db.select().from(userTable).where(eq(userTable.discordId, user.id));

  if (!userData) {
    await errorReply(opId, interaction, "User Not Found", `${user.username} is not registered.`, { deferred: true });
    return;
  }

  const startOfMonth = await getMonthStartDate();

  // Get tracked voice sessions this month, ordered by joinedAt for merging
  const voiceSessions = await db
    .select({
      duration: voiceSessionTable.duration,
      channelName: voiceSessionTable.channelName,
      joinedAt: voiceSessionTable.joinedAt,
      leftAt: voiceSessionTable.leftAt,
      points: voiceSessionTable.points,
    })
    .from(voiceSessionTable)
    .where(
      and(
        eq(voiceSessionTable.discordId, user.id),
        eq(voiceSessionTable.isTracked, true),
        gte(voiceSessionTable.leftAt, startOfMonth),
      ),
    )
    .orderBy(asc(voiceSessionTable.joinedAt));

  const tz = userData.timezone;
  const mergedSessions: MergedSession[] = [];

  for (const session of voiceSessions) {
    const last = mergedSessions.at(-1);
    const sessionJoinedAt = session.joinedAt;
    const sessionLeftAt = session.leftAt;

    // Check if should merge: same channel, consecutive (within 2 sec tolerance), not crossing midnight
    const shouldMerge =
      last?.channelName === session.channelName &&
      last.leftAt &&
      Math.abs(last.leftAt.getTime() - sessionJoinedAt.getTime()) < 2000 &&
      dayjs(last.leftAt).tz(tz).format("YYYY-MM-DD") === dayjs(sessionJoinedAt).tz(tz).format("YYYY-MM-DD");

    if (shouldMerge) {
      last.leftAt = sessionLeftAt;
      last.duration += session.duration ?? 0;
    } else {
      mergedSessions.push({
        channelName: session.channelName,
        joinedAt: sessionJoinedAt,
        leftAt: sessionLeftAt,
        duration: session.duration ?? 0,
      });
    }
  }

  // Build session lines
  const sessionLines =
    mergedSessions.length > 0
      ? mergedSessions
          .map((s) => {
            const joinStr = dayjs(s.joinedAt).tz(tz).format("D HH:mm");
            const leftStr = s.leftAt ? dayjs(s.leftAt).tz(tz).format("HH:mm") : "ongoing";
            const channel = s.channelName ?? "Unknown";
            return `• ${joinStr}-${leftStr} **${channel.slice(0, 3)}** (${formatDuration(s.duration)})`;
          })
          .join("\n")
      : "No sessions";

  await interaction.editReply({
    embeds: [
      {
        color: BOT_COLORS.INFO,
        title: `${user.displayName}'s Detailed Sessions`,
        description: sessionLines,
        footer: { text: `Month: ${dayjs().format("MMMM YYYY")} | TZ: ${tz}` },
      },
    ],
  });
}
