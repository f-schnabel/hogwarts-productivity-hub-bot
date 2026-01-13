import { SlashCommandBuilder, ChatInputCommandInteraction, userMention } from "discord.js";
import dayjs from "dayjs";
import { db, getMonthStartDate } from "../db/db.ts";
import { submissionTable, userTable, voiceSessionTable } from "../db/schema.ts";
import { and, asc, eq, gte } from "drizzle-orm";
import { formatDuration, errorReply, inGuild, requireRole } from "../utils/interactionUtils.ts";
import { BOT_COLORS, Role } from "../utils/constants.ts";
import type { CommandOptions } from "../types.ts";
import { calculatePointsHelper } from "../services/pointsService.ts";
import { stripIndent } from "common-tags";

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

  const totalSubmissionPoints = submissions.reduce((sum, s) => sum + s.points, 0);
  const totalVoiceSeconds = voiceSessions.reduce((sum, s) => sum + (s.duration ?? 0), 0);

  // Group by day in user's timezone
  const tz = userData.timezone;
  const dailyData = new Map<string, { voiceSeconds: number; submissionPoints: number; submissionCount: number }>();

  for (const session of voiceSessions) {
    const day = dayjs(session.joinedAt).tz(tz).format("YYYY-MM-DD");
    const existing = dailyData.get(day) ?? { voiceSeconds: 0, submissionPoints: 0, submissionCount: 0 };
    existing.voiceSeconds += session.duration ?? 0;
    dailyData.set(day, existing);
  }

  for (const submission of submissions) {
    const day = dayjs(submission.submittedAt).tz(tz).format("YYYY-MM-DD");
    const existing = dailyData.get(day) ?? { voiceSeconds: 0, submissionPoints: 0, submissionCount: 0 };
    existing.submissionPoints += submission.points;
    existing.submissionCount += 1;
    dailyData.set(day, existing);
  }

  // Sort days and build lines
  const sortedDays = [...dailyData.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const dailyLines =
    sortedDays.length > 0
      ? sortedDays
          .map(([day, data]) => {
            const dayLabel = dayjs(day).format("MMM D");
            const voicePoints = calculatePointsHelper(data.voiceSeconds);
            const dailyTotal = voicePoints + data.submissionPoints;
            const parts: string[] = [];
            if (data.voiceSeconds > 0) parts.push(`${formatDuration(data.voiceSeconds)} (${voicePoints} pt)`);
            if (data.submissionPoints > 0) {
              const todoLabel = data.submissionCount === 1 ? "To-Do List" : "To-Do Lists";
              parts.push(`${todoLabel} (${data.submissionPoints} pt)`);
            }
            return `• ${dayLabel}: **${dailyTotal} pt** = ${parts.join(" + ")}`;
          })
          .join("\n")
      : "None";

  await interaction.editReply({
    embeds: [
      {
        color: BOT_COLORS.INFO,
        title: "Monthly Points Breakdown",
        description: `Viewing monthly points for ${userMention(user.id)}`,
        thumbnail: {
          url: user.displayAvatarURL(),
        },
        fields: [
          {
            name: `Daily Activity (${dayjs().tz(tz).format("z")})`,
            value: dailyLines,
          },
          {
            name: "Monthly Totals",
            value: stripIndent`
              Study: ${formatDuration(totalVoiceSeconds)}
              Submissions: ${totalSubmissionPoints} pts
              **Total: ${userData.monthlyPoints} pts**`,
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
