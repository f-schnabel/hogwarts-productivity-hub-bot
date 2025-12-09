import {
  AutocompleteInteraction,
  bold,
  ChatInputCommandInteraction,
  GuildMember,
  SlashCommandBuilder,
  time,
  TimestampStyles,
  User,
  type APIEmbedField,
} from "discord.js";
import { replyError, awardPoints } from "../utils/utils.ts";
import dayjs from "dayjs";
import { db, fetchTasks, fetchUserTimezone } from "../db/db.ts";
import { taskTable } from "../db/schema.ts";
import { and, desc, eq, gte } from "drizzle-orm";
import { BOT_COLORS, DAILY_TASK_LIMIT, TASK_MIN_TIME, TASK_POINT_SCORE } from "../utils/constants.ts";
import assert from "node:assert/strict";
import { createProgressSection } from "../utils/visualHelpers.ts";
import type { Task } from "../types.ts";

export default {
  data: new SlashCommandBuilder()
    .setName("tasks")
    .setDescription("Manage your personal todo list")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("add")
        .setDescription("Add a new task to your personal to-do list")
        .addStringOption((option) =>
          option
            .setName("title")
            .setDescription("The task description")
            .setRequired(true)
            .setMinLength(1)
            .setMaxLength(500),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("view")
        .setDescription("View all your tasks with their numbers")
        .addMentionableOption((option) =>
          option
            .setName("user")
            .setDescription("View tasks for a specific user (default: yourself)")
            .setRequired(false),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("remove")
        .setDescription("Remove a task from your to-do list")
        .addIntegerOption((option) =>
          option
            .setName("task")
            .setDescription("The task to remove (use `/tasks view` to see all)")
            .setRequired(true)
            .setAutocomplete(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("complete")
        .setDescription("Mark a task as complete and earn 2 points")
        .addIntegerOption((option) =>
          option
            .setName("task")
            .setDescription("The task number to complete (use `/tasks view` to see numbers)")
            .setRequired(true)
            .setAutocomplete(true),
        ),
    ),
  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply();
    const discordId = interaction.user.id;

    const userTimezone = await fetchUserTimezone(discordId);
    const startOfDay = dayjs().tz(userTimezone).startOf("day").toDate();
    console.debug(`Task command with User timezone: ${userTimezone}, start of day: ${startOfDay.toString()}`);

    switch (interaction.options.getSubcommand()) {
      case "add":
        await addTask(interaction, discordId, userTimezone, startOfDay);
        break;
      case "view":
        await viewTasks(interaction, startOfDay);
        break;
      case "complete":
        await completeTask(interaction, discordId, startOfDay);
        break;
      case "remove":
        await removeTask(interaction, discordId, startOfDay);
        break;
      default:
        await replyError(
          interaction,
          "Invalid Subcommand",
          "Please use `/tasks add`, `/tasks view`, `/tasks complete`, or `/tasks remove`.",
        );
        return;
    }
  },
  autocomplete: async (interaction: AutocompleteInteraction) => {
    // TODO will also old tasks be shown?
    const tasks = await fetchTasks(interaction.user.id);
    await interaction.respond(
      tasks.map((task) => ({
        name: task.title,
        value: task.id,
      })),
    );
  },
};

async function addTask(
  interaction: ChatInputCommandInteraction,
  discordId: string,
  userTimezone: string,
  startOfDay: Date,
): Promise<void> {
  const title = interaction.options.getString("title", true);

  // Check daily task limit first
  const currentTaskCount = await db.$count(
    taskTable,
    and(eq(taskTable.discordId, discordId), gte(taskTable.createdAt, startOfDay)),
  );
  if (currentTaskCount >= DAILY_TASK_LIMIT) {
    const resetTime = dayjs().tz(userTimezone).add(1, "day").startOf("day").toDate();

    await interaction.editReply({
      embeds: [
        {
          color: BOT_COLORS.WARNING,
          title: `Daily Task Limit Reached`,
          description:
            `You have reached your daily task limit of ${DAILY_TASK_LIMIT} tasks.\n` +
            "You can add more tasks tomorrow after the daily reset or by removing existing tasks(`/tasks remove`).\n" +
            `**Your Daily Reset:** ${time(resetTime, TimestampStyles.RelativeTime)}`,
          footer: {
            text: "Tip: You can change your timezone with /timezone if your daily reset is not at midnight",
          },
        },
      ],
    });
    return;
  }

  const [task] = await db.insert(taskTable).values({ discordId, title }).returning({ title: taskTable.title });
  assert(task !== undefined, "Task should be created successfully");

  await interaction.editReply({
    embeds: [
      {
        color: BOT_COLORS.SUCCESS,
        title: `Task Added Successfully!`,
        description: `**${task.title}**\n\n`,
        footer: {
          text:
            "Your task has been added to your personal to-do list and is ready for completion.\n" +
            "After you are done you can finish it with `/task complete`",
        },
      },
    ],
  });
}

async function viewTasks(interaction: ChatInputCommandInteraction, startOfDay: Date): Promise<void> {
  const userMention = interaction.options.getMentionable("user");

  let user;
  if (userMention === null) {
    user = interaction.user;
  } else if (userMention instanceof User) {
    user = userMention;
  } else if (userMention instanceof GuildMember) {
    user = userMention.user;
  } else {
    await replyError(
      interaction,
      "Invalid User Mention",
      "Please mention a valid user or leave it blank to view your own tasks.",
    );
    return;
  }

  const tasks = (await db
    .select({
      title: taskTable.title,
      isCompleted: taskTable.isCompleted,
      completedAt: taskTable.completedAt,
      createdAt: taskTable.createdAt,
    })
    .from(taskTable)
    .where(and(eq(taskTable.discordId, user.id), gte(taskTable.createdAt, startOfDay)))
    .orderBy(desc(taskTable.isCompleted), taskTable.createdAt)) as Task[];

  assert(
    tasks.length <= DAILY_TASK_LIMIT,
    `Expected tasks length to be less than ${DAILY_TASK_LIMIT} but found ${tasks.length}`,
  );

  if (tasks.length === 0) {
    await interaction.editReply({
      embeds: [
        {
          color: BOT_COLORS.INFO,
          title: "📋 Your Task Dashboard",
          description: "Ready to get productive?\nUse `/tasks add` to create your first task!",
          footer: {
            text: `Tip: Completing tasks earns you ${TASK_POINT_SCORE} points each!`,
          },
          thumbnail: {
            url: user.displayAvatarURL(),
          },
        },
      ],
    });
    return;
  }

  const incompleteTasks = tasks.filter((t) => !t.isCompleted);
  const completedTasks = tasks.filter((t) => t.isCompleted === true);

  const fields: APIEmbedField[] = [
    {
      name: "📊 Progress Tracking",
      value: createProgressSection(completedTasks.length, tasks.length),
    },
  ];

  // Add pending tasks
  if (incompleteTasks.length > 0) {
    fields.push({
      name: `📌 Pending Tasks • ${incompleteTasks.length} remaining`,
      value: incompleteTasks.map((task, index) => `${index + 1}. ${task.title}`).join("\n"),
      inline: false,
    });
  }

  // Add completed tasks
  if (completedTasks.length > 0) {
    fields.push(
      {
        name: `✅ Recently Completed • ${completedTasks.length} total`,
        value: completedTasks
          .toSorted((a, b) => b.completedAt.getTime() - a.completedAt.getTime())
          .map(
            (task, index) =>
              `${index + 1}. ${task.title} at ${time(task.completedAt, TimestampStyles.ShortTime)} (+${TASK_POINT_SCORE} points)`,
          )
          .join("\n"),
      },
      {
        name: "Total Points Earned from Tasks",
        value: `${completedTasks.length * TASK_POINT_SCORE} points`,
      },
    );
  }

  await interaction.editReply({
    embeds: [
      {
        color: BOT_COLORS.PRIMARY,
        title: `📋 Task Dashboard for **${user.username}**`,
        fields,
        footer: {
          text: "Use /task complete to complete tasks or /task remove to remove tasks",
        },
        thumbnail: {
          url: user.displayAvatarURL(),
        },
      },
    ],
  });
}

async function completeTask(
  interaction: ChatInputCommandInteraction,
  discordId: string,
  startOfDay: Date,
): Promise<void> {
  const taskId = interaction.options.getInteger("task", true);

  // Get all incomplete tasks for the user, ordered by creation date
  const [tasks] = await db
    .select()
    .from(taskTable)
    .where(
      and(
        eq(taskTable.discordId, discordId),
        eq(taskTable.isCompleted, false),
        eq(taskTable.id, taskId),
        gte(taskTable.createdAt, startOfDay),
      ),
    )
    .orderBy(taskTable.createdAt);

  if (tasks === undefined) {
    await replyError(
      interaction,
      `Task Completion Failed`,
      `Could not find task. Use \`/tasks view\` to check your tasks`,
    );
    return;
  }

  const taskToComplete = tasks;
  const diffInMinutes = dayjs().diff(dayjs(taskToComplete.createdAt), "minute");
  if (diffInMinutes < TASK_MIN_TIME) {
    await replyError(
      interaction,
      `Task Completion Failed`,
      `You can only complete tasks that are at least ${TASK_MIN_TIME} minutes old.`,
      `Please try again in ${TASK_MIN_TIME - diffInMinutes} min.`,
    );
    return;
  }

  // Mark task as complete
  await db.transaction(async (db) => {
    await db
      .update(taskTable)
      .set({
        isCompleted: true,
        completedAt: new Date(),
      })
      .where(eq(taskTable.id, taskToComplete.id));
    await awardPoints(db, discordId, TASK_POINT_SCORE);
  });

  await interaction.editReply({
    embeds: [
      {
        color: BOT_COLORS.SUCCESS,
        title: `🎉 Task Completed Successfully!`,
        description: bold(`Completed: "${taskToComplete.title}" (+${TASK_POINT_SCORE} points)`),
        footer: {
          text: "🚀 Great job on completing your task! Keep up the momentum and continue building your productivity streak.",
        },
      },
    ],
  });
}

async function removeTask(
  interaction: ChatInputCommandInteraction,
  discordId: string,
  startOfDay: Date,
): Promise<void> {
  const taskId = interaction.options.getInteger("task", true);

  const [task] = await db
    .delete(taskTable)
    .where(
      and(
        eq(taskTable.discordId, discordId),
        eq(taskTable.isCompleted, false),
        eq(taskTable.id, taskId),
        gte(taskTable.createdAt, startOfDay),
      ),
    )
    .returning({ id: taskTable.id, title: taskTable.title });

  if (task === undefined) {
    await replyError(interaction, `Task Removal Failed`, "Task not found. Use `/tasks view` to check your tasks.");
    return;
  }

  await interaction.editReply({
    embeds: [
      {
        color: BOT_COLORS.SUCCESS,
        title: `Task Removed Successfully`,
        description: `**Removed task: "${task.title}"**`,
        footer: {
          text: "The task has been permanently removed from your to-do list.",
        },
      },
    ],
  });
}
