import { SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";
import dayjs from "dayjs";
import { BOT_COLORS } from "../../utils/constants.ts";
import { db } from "../../db/db.ts";
import { taskTable, userTable } from "../../db/schema.ts";
import { and, eq, gt } from "drizzle-orm";
import assert from "node:assert";
import { timeToHours } from "../../utils/utils.ts";

export default {
  data: new SlashCommandBuilder().setName("stats").setDescription("View your productivity statistics"),
  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply();

    const discordId = interaction.user.id;
    const [userStats] = await db.select().from(userTable).where(eq(userTable.discordId, discordId));
    assert(userStats !== undefined, "User stats not found in database");

    // Fetch user tasks with error handling
    const startOfDay = dayjs().tz(userStats.timezone).startOf("day").toDate();
    const userTasks = await db
      .select()
      .from(taskTable)
      .where(and(eq(taskTable.discordId, discordId), gt(taskTable.createdAt, startOfDay)));

    // 5. Pending Tasks (show actual tasks, not just count)
    const pendingTasks = userTasks.filter((task) => !task.isCompleted);
    let pendingTasksValue;

    if (userTasks.length === 0) {
      pendingTasksValue = "**No tasks yet** 🎯";
    } else if (pendingTasks.length === 0) {
      pendingTasksValue = "**All caught up!** 🎉";
    } else {
      // Show all tasks if 3 or fewer
      const taskList = pendingTasks
        .slice(0, 3)
        .map(
          (task, index) => `${index + 1}. ${task.title.length > 35 ? task.title.substring(0, 32) + "..." : task.title}`,
        )
        .join("\n");
      pendingTasksValue = `**${pendingTasks.length}** tasks:\n${taskList}`;
      if (pendingTasks.length > 3) {
        pendingTasksValue += `\n*...and ${pendingTasks.length - 3} more*`;
      }
    }

    // Personalized greeting based on streak
    let greeting = "";
    if (userStats.voiceStreak >= 7) {
      greeting = `Hey ${userStats.username}! You're on a ${userStats.voiceStreak}-day streak! 🔥`;
    } else if (userStats.voiceStreak > 0) {
      greeting = `Great work ${userStats.username}! ${userStats.voiceStreak} days and counting! 💪`;
    } else {
      greeting = `Hi ${userStats.username}! Ready to start your productivity journey? 👋`;
    }

    const userLocalTime = dayjs().tz(userStats.timezone);
    const nextMidnight = dayjs().tz(userStats.timezone).add(1, "day").startOf("day");
    const hoursUntilReset = nextMidnight.diff(userLocalTime, "hour");

    await interaction.editReply({
      embeds: [
        {
          title: "📊 Your Stats",
          color: BOT_COLORS.PRIMARY,
          description: greeting,
          fields: [
            // 1. Streak Information
            {
              name: "Current Streak 🔥",
              value: `**${userStats.voiceStreak}** days`,
              inline: true,
            },
            // 2. Voice Channel Hours (today, this month, all-time)
            {
              name: "🎧 Voice Hours",
              value: [
                `**Today:** ${timeToHours(userStats.dailyVoiceTime)}`,
                `**This Month:** ${timeToHours(userStats.monthlyVoiceTime)}`,
                `**All-Time:** ${timeToHours(userStats.totalVoiceTime)}`,
              ].join("\n"),
              inline: true,
            },
            // 4. Points Breakdown (today, this month, all-time)
            {
              name: "Points Earned 💰",
              value: [
                `**Today:** ${userStats.dailyPoints} points`,
                `**This Month:** ${userStats.monthlyPoints} points`,
                `**All-Time:** ${userStats.totalPoints} points`,
              ].join("\n"),
              inline: true,
            },
            {
              name: "Pending Tasks 📋",
              value: pendingTasksValue,
              inline: true,
            },
            // Add a simple spacer field to balance the layout
            {
              name: "\u200b",
              value: "\u200b",
              inline: true,
            },
          ],
          thumbnail: {
            url: interaction.user.displayAvatarURL(),
          },
          // Add timezone context to footer for user awareness
          footer: {
            text: `Your timezone: ${userStats.timezone} | Local time: ${userLocalTime.format("h:mm A")} | Daily reset in ${hoursUntilReset}h 🌍`,
          },
        },
      ],
    });
  },
};
