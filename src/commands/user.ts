import { SlashCommandBuilder, ChatInputCommandInteraction, GuildMember } from "discord.js";
import dayjs from "dayjs";
import { db } from "../db/db.ts";
import { settingsTable, submissionTable, userTable, voiceSessionTable } from "../db/schema.ts";
import { and, asc, eq, gte } from "drizzle-orm";
import { hasAnyRole, replyError, Role } from "../utils/utils.ts";
import { BOT_COLORS, SETTINGS_KEYS } from "../utils/constants.ts";
import { formatDuration } from "../utils/voiceUtils.ts";

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

  // Merge consecutive sessions in same channel with <= 1 min gap
  const mergedSessions: typeof voiceSessions = [];
  for (const session of voiceSessions) {
    const last = mergedSessions[mergedSessions.length - 1];
    if (last?.channelName === session.channelName && dayjs(session.joinedAt).diff(dayjs(last.leftAt), "second") <= 60) {
      last.leftAt = session.leftAt;
      last.duration = (last.duration ?? 0) + (session.duration ?? 0);
    } else {
      mergedSessions.push({ ...session });
    }
  }

  // Build response
  const submissionLines =
    submissions.length > 0
      ? submissions.map((s) => `• ${s.points} pts (${dayjs(s.reviewedAt).format("MMM D")})`).join("\n")
      : "None";

  const voiceLines =
    mergedSessions.length > 0
      ? mergedSessions
          .map(
            (s) =>
              `•${dayjs(s.joinedAt).tz(userData.timezone).format("MMM D HH:mm")} - ${dayjs(s.leftAt).tz(userData.timezone).format("HH:mm z")} in ${s.channelName} (${formatDuration(s.duration ?? 0)})`,
          )
          .join("\n")
      : "None";

  await interaction.editReply({
    embeds: [
      {
        color: BOT_COLORS.INFO,
        title: `${user.displayName}'s Monthly Points Breakdown`,
        fields: [
          {
            name: `Submissions (${totalSubmissionPoints} pts)`,
            value: submissionLines,
          },
          {
            name: `Study Time (${formatDuration(totalVoiceSeconds)})`,
            value: voiceLines,
          },
          {
            name: "Total Monthly Points",
            value: `**${userData.monthlyPoints}** pts`,
            inline: true,
          },
        ],
        footer: { text: `Month: ${dayjs().format("MMMM YYYY")}` },
      },
    ],
  });
}
