import { SlashCommandBuilder, ChatInputCommandInteraction, GuildMember } from "discord.js";
import dayjs from "dayjs";
import { db } from "../db/db.ts";
import { settingsTable, submissionTable, userTable, voiceSessionTable } from "../db/schema.ts";
import { and, asc, eq, gte } from "drizzle-orm";
import { hasAnyRole, replyError, Role } from "../utils/utils.ts";
import { BOT_COLORS, SETTINGS_KEYS } from "../utils/constants.ts";
import { calculatePointsHelper, formatDuration } from "../utils/voiceUtils.ts";

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
        .setDescription("View breakdown of a user's monthly points (OWNER/PREFECT only)")
        .addUserOption((option) =>
          option.setName("user").setDescription("The user to view points for").setRequired(true),
        ),
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply();

    switch (interaction.options.getSubcommand()) {
      case "time":
        await time(interaction);
        break;
      case "points":
        await points(interaction);
        break;
      default:
        await replyError(interaction, "Invalid Subcommand", "Please use `/user time` or `/user points`.");
        return;
    }
  },
};

async function time(interaction: ChatInputCommandInteraction) {
  const user = interaction.options.getUser("user", true);
  const [userData] = await db.select().from(userTable).where(eq(userTable.discordId, user.id));

  if (!userData?.timezone) {
    await replyError(interaction, "Timezone Not Set", `${user.username} has not set their timezone.`);
    return;
  }
  await interaction.editReply(
    `${user.displayName}'s current time is ${dayjs().tz(userData.timezone).format("YYYY-MM-DD hh:mm:ss A")}`,
  );
}

async function points(interaction: ChatInputCommandInteraction) {
  const member = interaction.member as GuildMember;
  if (!hasAnyRole(member, Role.OWNER | Role.PREFECT)) {
    await replyError(interaction, "Insufficient Permissions", "Only OWNER or PREFECT can use this command.");
    return;
  }

  const user = interaction.options.getUser("user", true);
  const [userData] = await db.select().from(userTable).where(eq(userTable.discordId, user.id));

  if (!userData) {
    await replyError(interaction, "User Not Found", `${user.username} is not registered.`);
    return;
  }

  // Get last monthly reset timestamp from settings
  const [setting] = await db
    .select()
    .from(settingsTable)
    .where(eq(settingsTable.key, SETTINGS_KEYS.LAST_MONTHLY_RESET));
  const startOfMonth = setting ? new Date(setting.value) : dayjs().startOf("month").toDate();

  // Get approved submissions this month
  const submissions = await db
    .select({
      points: submissionTable.points,
      reviewedAt: submissionTable.reviewedAt,
    })
    .from(submissionTable)
    .where(
      and(
        eq(submissionTable.discordId, user.id),
        eq(submissionTable.status, "APPROVED"),
        gte(submissionTable.reviewedAt, startOfMonth),
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
  const dailyData = new Map<string, { voiceSeconds: number; submissionPoints: number }>();

  for (const session of voiceSessions) {
    const day = dayjs(session.joinedAt).tz(tz).format("YYYY-MM-DD");
    const existing = dailyData.get(day) ?? { voiceSeconds: 0, submissionPoints: 0 };
    existing.voiceSeconds += session.duration ?? 0;
    dailyData.set(day, existing);
  }

  for (const submission of submissions) {
    const day = dayjs(submission.reviewedAt).tz(tz).format("YYYY-MM-DD");
    const existing = dailyData.get(day) ?? { voiceSeconds: 0, submissionPoints: 0 };
    existing.submissionPoints += submission.points;
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
            if (voicePoints > 0) parts.push(`${voicePoints}pt vc`);
            if (data.submissionPoints > 0) parts.push(`${data.submissionPoints}pt submitted`);
            const duration = data.voiceSeconds > 0 ? ` (${formatDuration(data.voiceSeconds)})` : "";
            return `• ${dayLabel}: **${dailyTotal}pt** = ${parts.join(" + ")}${duration}`;
          })
          .join("\n")
      : "None";

  await interaction.editReply({
    embeds: [
      {
        color: BOT_COLORS.INFO,
        title: `${user.displayName}'s Monthly Points Breakdown`,
        fields: [
          {
            name: `Daily Activity (${dayjs().tz(tz).format("z")})`,
            value: dailyLines,
          },
          {
            name: "Monthly Totals",
            value: `Study: ${formatDuration(totalVoiceSeconds)}\nSubmissions: ${totalSubmissionPoints} pts\n**Total: ${userData.monthlyPoints} pts**`,
          },
        ],
        footer: { text: `Month: ${dayjs().format("MMMM YYYY")}` },
      },
    ],
  });
}
