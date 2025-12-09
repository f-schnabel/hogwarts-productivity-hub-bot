import { SlashCommandBuilder, ChatInputCommandInteraction, type VoiceBasedChannel, EmbedBuilder } from "discord.js";
import { getUserVoiceChannel } from "../utils/voiceUtils.ts";
import { replyError } from "../utils/utils.ts";
import dayjs from "dayjs";
import type { Command, VoiceTimer } from "../types.ts";
import assert from "node:assert";
import { createProgressBar } from "../utils/visualHelpers.ts";
import { BOT_COLORS } from "../utils/constants.ts";

export default {
  data: new SlashCommandBuilder()
    .setName("timer")
    .setDescription("Manage Pomodoro timers for productivity tracking")
    .addSubcommand((sub) =>
      sub
        .setName("start")
        .setDescription("Start a Pomodoro timer")
        .addIntegerOption((opt) =>
          opt.setName("work").setDescription("Work time in minutes (min 20)").setRequired(true).setMinValue(20),
        )
        .addIntegerOption((opt) =>
          opt
            .setName("break")
            .setDescription("Break time in minutes (optional, min 5)")
            .setRequired(false)
            .setMinValue(5),
        ),
    )
    .addSubcommand((sub) => sub.setName("stop").setDescription("Stop the current Pomodoro timer"))
    .addSubcommand((sub) => sub.setName("status").setDescription("Check the status of the current Pomodoro timer")),
  async execute(interaction: ChatInputCommandInteraction, { activeVoiceTimers }): Promise<void> {
    await interaction.deferReply();

    const subcommand = interaction.options.getSubcommand(true);

    switch (subcommand) {
      case "start":
        await startTimer(interaction, activeVoiceTimers);
        break;
      case "stop":
        await stopTimer(interaction, activeVoiceTimers);
        break;
      case "status":
        await checkTimerStatus(interaction, activeVoiceTimers);
        break;
    }
  },
} as Command;

async function startTimer(
  interaction: ChatInputCommandInteraction,
  activeVoiceTimers: Map<string, VoiceTimer>,
): Promise<void> {
  const voiceChannel = getUserVoiceChannel(interaction);

  if (voiceChannel === null) {
    await replyError(
      interaction,
      `Voice Channel Required`,
      "You must be in a voice channel to start a Pomodoro timer and track your productivity.\nJoin any voice channel first, then try again.\nTimers help you maintain focus during productive voice sessions.",
    );
    return;
  }

  const voiceChannelId = voiceChannel.id;

  if (!(await cleanExistingTimer(interaction, voiceChannelId, activeVoiceTimers))) {
    return;
  }

  const work = interaction.options.getInteger("work", true);
  const breakTime = interaction.options.getInteger("break") ?? 0;

  const now = dayjs();
  const startTime = now;
  const endTime = now.add(work, "minutes");
  const breakEndTime = breakTime > 0 ? now.add(work + breakTime, "minutes") : null;

  await interaction.editReply({
    embeds: [
      createTimerTemplate(
        "start",
        {
          workTime: work,
          breakTime: breakTime,
          voiceChannel: voiceChannel,
          phase: "work",
          startTime: startTime.format("HH:mm"),
          endTime: endTime.format("HH:mm"),
          breakEndTime: breakEndTime?.format("HH:mm"),
        },
        {
          showProgress: true,
          includeMotivation: true,
        },
      ),
    ],
  });

  const workTimeout = setTimeout(
    () =>
      void (async () => {
        await interaction.followUp({
          content: `<@${interaction.user.id}>`,
          embeds: [
            createTimerTemplate("work_complete", {
              workTime: work,
              breakTime: breakTime,
              voiceChannel: voiceChannel,
              phase: "work_complete",
            }),
          ],
        });

        if (breakTime === 0) {
          activeVoiceTimers.delete(voiceChannelId);
          return;
        }

        const breakTimeout = setTimeout(
          () =>
            void (async () => {
              try {
                await interaction.followUp({
                  content: `<@${interaction.user.id}>`,
                  embeds: [
                    createTimerTemplate("break_complete", {
                      workTime: work,
                      breakTime: breakTime,
                      voiceChannel: voiceChannel,
                      phase: "break_complete",
                    }),
                  ],
                });
              } catch (err) {
                console.error("Error sending break over message:", err);
              }
              activeVoiceTimers.delete(voiceChannelId);
            })(),
          breakTime * 60 * 1000,
        );
        activeVoiceTimers.set(voiceChannelId, {
          startTime: startTime.valueOf(),
          breakTimeout,
          phase: "break",
          endTime: dayjs().add(breakTime, "minutes").toDate(),
        });
      })(),
    work * 60 * 1000,
  );
  activeVoiceTimers.set(voiceChannelId, {
    startTime: startTime.valueOf(),
    workTimeout,
    phase: "work",
    endTime: dayjs().add(work, "minutes").toDate(),
  });
}

async function cleanExistingTimer(
  interaction: ChatInputCommandInteraction,
  voiceChannelId: string,
  activeVoiceTimers: Map<string, VoiceTimer>,
): Promise<boolean> {
  const existingTimer = activeVoiceTimers.get(voiceChannelId);

  // Enforce: only one timer per voice channel
  if (existingTimer === undefined) return true;

  const timeRemaining = Math.ceil((existingTimer.endTime.getTime() - Date.now()) / 60000);

  // If timer has already expired, clean it up
  if (timeRemaining <= 0) {
    console.log(`Expired timer found for channel ${voiceChannelId}, cleaning up...`);
    if (existingTimer.workTimeout) clearTimeout(existingTimer.workTimeout);
    if (existingTimer.breakTimeout) clearTimeout(existingTimer.breakTimeout);
    activeVoiceTimers.delete(voiceChannelId);
    return true;
  }

  // Timer is valid and active, reject the new timer request
  await replyError(
    interaction,
    `Timer Already Running`,
    `A Pomodoro timer is already active in <#${voiceChannelId}>! Only one timer per voice channel is allowed.`,
    `Use \`/stoptimer\` to stop the current timer first`,
    `**Current Phase:** ${existingTimer.phase.toUpperCase()}`,
    `**Time Remaining:** ${timeRemaining} minutes`,
  );
  return false;
}

async function stopTimer(interaction: ChatInputCommandInteraction, activeVoiceTimers: Map<string, VoiceTimer>) {
  // Use the reliable voice channel detection utility
  const voiceChannel = getUserVoiceChannel(interaction);

  if (!voiceChannel) {
    await replyError(
      interaction,
      `Voice Channel Required`,
      "You must be in a voice channel to stop a timer and manage your productivity sessions.",
      "Join the voice channel with an active timer",
      "Timer controls are tied to your current voice channel location.",
    );
    return;
  }

  const voiceChannelId = voiceChannel.id;
  const timer = activeVoiceTimers.get(voiceChannelId);
  if (timer === undefined) {
    await replyError(
      interaction,
      `No Active Timer Found`,
      `No Pomodoro timer is currently running in <#${voiceChannelId}>. There's nothing to stop!`,
      `Use \`/timer <work_minutes>\` to start a new Pomodoro session`,
      `Check \`/time\` to see if there are any active timers in your current voice channel.`,
    );
    return;
  }
  if (timer.workTimeout) clearTimeout(timer.workTimeout);
  if (timer.breakTimeout) clearTimeout(timer.breakTimeout);
  activeVoiceTimers.delete(voiceChannelId);

  await interaction.editReply({
    embeds: [
      {
        color: BOT_COLORS.SUCCESS,
        title: `✅ Timer Stopped Successfully`,
        description: `Your Pomodoro timer in <#${voiceChannelId}> has been stopped. 🚀 No worries - every session counts towards building your productivity habits!`,
        footer: {
          text: `🌍 Timer stopped | Use /timer start to start a new session`,
        },
      },
    ],
  });
}

async function checkTimerStatus(interaction: ChatInputCommandInteraction, activeVoiceTimers: Map<string, VoiceTimer>) {
  // Get user's voice channel
  const voiceChannel = getUserVoiceChannel(interaction);

  if (!voiceChannel) {
    await replyError(
      interaction,
      `Voice Channel Required`,
      `You must be in a voice channel to check timer status and track your productivity sessions.\nJoin a voice channel first, then try again`,
    );
    return;
  }

  const voiceChannelId = voiceChannel.id;

  const timer = activeVoiceTimers.get(voiceChannelId);
  // Check if there's an active timer in this voice channel
  if (timer === undefined) {
    await interaction.editReply({
      embeds: [
        createTimerTemplate(
          "no_timer",
          {
            voiceChannel: voiceChannel,
          },
          { includeMotivation: true },
        ),
      ],
    });
    return;
  }

  const now = Date.now();
  const timeRemaining = Math.max(0, Math.ceil((timer.endTime.getTime() - now) / 1000 / 60));

  await interaction.editReply({
    embeds: [
      createTimerTemplate(
        "status",
        {
          voiceChannel: voiceChannel,
          phase: timer.phase,
          timeRemaining: timeRemaining,
          workTime: timer.phase === "work" ? timeRemaining + Math.ceil((now - timer.startTime) / 1000 / 60) : null,
          breakTime: timer.phase === "break" ? timeRemaining + Math.ceil((now - timer.startTime) / 1000 / 60) : null,
        },
        { showProgress: true },
      ),
    ],
  });
}

// ⏱️ Timer Template
function createTimerTemplate(
  action: "start" | "work_complete" | "break_complete" | "status" | "no_timer",
  data: {
    workTime?: number | null;
    breakTime?: number | null;
    voiceChannel: VoiceBasedChannel;
    phase?: "work" | "break" | "work_complete" | "break_complete";
    startTime?: string;
    endTime?: string;
    breakEndTime?: string;
    timeRemaining?: number;
  },
  { showProgress = true, includeMotivation = true } = {},
) {
  let embed;

  switch (action) {
    case "start": {
      assert(data.workTime, "Work time must be provided for starting a timer");
      assert(data.breakTime, "Break time must be provided for starting a timer");
      // Add timer configuration
      const configFields = [
        `🕒 **Work Time:** ${data.workTime} minutes`,
        data.breakTime > 0 ? `☕ **Break Time:** ${data.breakTime} minutes` : null,
        `📍 **Location:** <#${data.voiceChannel.id}>`,
      ].filter(Boolean);

      embed = new EmbedBuilder({
        color: BOT_COLORS.PRIMARY,
        title: "⏱️ Pomodoro Timer Started",
        description: "Focus Session Active\n" + "Time to boost your productivity!",
        fields: [
          {
            name: "📋 Session Configuration",
            value: configFields.join("\n"),
            inline: false,
          },
        ],
      });

      if (showProgress) {
        const progressBar = createProgressBar(0, data.workTime, 15, "▓", "░");
        embed.addFields([
          {
            name: "📊 Progress Tracker",
            value: `${progressBar.bar}\n**Phase:** Work Session • **Status:** 🔄 Active`,
            inline: false,
          },
        ]);
      }

      if (includeMotivation) {
        embed.addFields([
          {
            name: "💪 Stay Focused!",
            value: "Focus time! Good luck with your session!\nRemember: great achievements require focused effort.",
            inline: false,
          },
        ]);
      }

      embed.setFooter({
        text: "Use /stoptimer if you need to stop early • /time to check remaining time",
      });
      break;
    }

    case "work_complete":
      assert(data.breakTime, "Break time must be provided for work completion");
      embed = new EmbedBuilder({
        color: BOT_COLORS.SUCCESS,
        title: "🔔 Work Session Complete!",
        description: "Great Work!\nYou've successfully completed your focus session",
      });

      if (data.breakTime > 0) {
        embed.addFields([
          {
            name: "☕ Break Time!",
            value: `Take a well-deserved **${data.breakTime}-minute break**.\n🔔 I'll notify you when it's time to get back to work.`,
            inline: false,
          },
        ]);
      } else {
        embed.addFields([
          {
            name: "🎯 Session Finished!",
            value: "Great job staying focused! You've completed your productivity session.",
            inline: false,
          },
        ]);
      }
      break;

    case "break_complete":
      embed = new EmbedBuilder({
        color: BOT_COLORS.INFO,
        title: "🕒 Break Time Is Over!",
        description: "Back to Work!\nTime to get back to your productive flow",
        fields: [
          {
            name: "🎯 Ready to Focus",
            value: "Break's over! Time to get back to work.\nYou've got this! Stay focused and productive!",
            inline: false,
          },
        ],
      });

      break;

    case "status": {
      assert(data.phase, "Timer phase must be provided for status");
      assert(data.breakTime, "Break time must be provided for status");
      assert(data.workTime, "Work time must be provided for status");
      const isBreak = data.phase === "break";
      embed = new EmbedBuilder({
        color: isBreak ? BOT_COLORS.WARNING : BOT_COLORS.PRIMARY,
        title: `⏰ Timer Status - ${data.phase.charAt(0).toUpperCase() + data.phase.slice(1)} Phase`,
        description: `Active Session\nCurrently in ${data.phase} phase`,
      });

      if (showProgress && data.timeRemaining !== undefined) {
        const totalTime = isBreak ? data.breakTime : data.workTime;
        const elapsed = totalTime - data.timeRemaining;
        const progressBar = createProgressBar(elapsed, totalTime, 15);

        embed.addFields([
          {
            name: "📊 Progress",
            value: `${progressBar.bar}\n**Time Remaining:** ${data.timeRemaining} minutes • **Status:** 🔄 Active`,
            inline: false,
          },
        ]);
      }

      embed.addFields([
        {
          name: "📍 Session Info",
          value: `**Location:** <#${data.voiceChannel.id}>\n**Phase:** ${data.phase.charAt(0).toUpperCase() + data.phase.slice(1)}`,
          inline: false,
        },
      ]);
      break;
    }

    case "no_timer":
      embed = new EmbedBuilder({
        color: BOT_COLORS.SECONDARY,
        title: "⏰ Timer Status",
        description: `No Active Timer\nNo Pomodoro timer is currently running in <#${data.voiceChannel.id}>`,
        fields: [
          {
            name: "💡 Get Started",
            value:
              "Use `/timer <work_minutes>` to start a new Pomodoro session!\nRecommended: `/timer 25 5` for a classic 25-minute work session with 5-minute break.",
            inline: false,
          },
        ],
      });

      if (includeMotivation) {
        embed.addFields([
          {
            name: "🎯 Productivity Tips",
            value:
              "• Choose focused work periods (20-50 minutes)\n• Take regular breaks to maintain concentration\n• Stay in your voice channel during sessions",
            inline: false,
          },
        ]);
      }
      break;
  }

  return embed;
}
