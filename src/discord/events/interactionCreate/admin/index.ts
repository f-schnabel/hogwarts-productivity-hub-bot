import { ChatInputCommandInteraction, SlashCommandBuilder, AutocompleteInteraction } from "discord.js";
import {
  db,
  getMonthStartDate,
  getVCEmoji,
  getWeightedHousePoints,
  getUnweightedHousePoints,
  setMonthStartDate,
  setVCEmoji,
  setCountingState,
} from "@/db/db.ts";
import { awardPoints } from "@/discord/core/points.ts";
import { errorReply, inGuild } from "@/discord/utils/interaction.ts";
import { wrapWithAlerting } from "@/discord/utils/alerting.ts";
import {
  houseCupEntryTable,
  houseCupMonthTable,
  houseScoreboardTable,
  pointAdjustmentTable,
  submissionTable,
  userTable,
  voiceSessionTable,
} from "@/db/schema.ts";
import { HOUSES, Role } from "@/common/constants.ts";
import { refreshAllYearRoles } from "@/discord/events/voiceStateUpdate/yearRole.ts";
import { createLogger } from "@/common/logging/logger.ts";
import { updateMember } from "@/discord/utils/updateMember.ts";
import type { Command, Sums } from "@/common/types.ts";
import { getHousepointMessages, updateScoreboardMessages } from "../scoreboard/scoreboard.ts";
import { desc, eq, isNull, not } from "drizzle-orm";
import dayjs from "dayjs";
import assert from "assert";
import { journalDelete, journalExport, journalImport, journalList, journalSet, journalShow } from "./journal.ts";
import { requireRole } from "@/discord/utils/role.ts";
import { autocompleteTimezone, setTimezone } from "@/discord/core/timezone.ts";

const log = createLogger("Admin");
const ALLOWED_PREFECT_COMMANDS = ["timezone"];

export default {
  data: new SlashCommandBuilder()
    .setName("admin")
    .setDescription("Admin commands")
    .setDMPermission(false)
    .addSubcommand((subcommand) =>
      subcommand
        .setName("adjust-points")
        .setDescription("Adds or removes points from a user")
        .addIntegerOption((option) =>
          option.setName("amount").setDescription("The amount of points to adjust").setRequired(true),
        )
        .addUserOption((option) =>
          option.setName("user").setDescription("The user to adjust points for").setRequired(true),
        )
        .addStringOption((option) => option.setName("reason").setDescription("Reason for adjustment")),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName("reset-monthly-points").setDescription("Resets monthly points for all users"),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("refresh-ranks")
        .setDescription("Refreshes year roles for all users based on monthly voice time"),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("vc-emoji")
        .setDescription("Sets or gets the emoji for voice channel status")
        .addStringOption((option) =>
          option.setName("emoji").setDescription("The emoji to set as the voice channel status emoji"),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName("check-integrity").setDescription("Checks point integrity against transaction tables"),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName("fix-integrity").setDescription("Overwrites stored points/voice time with expected values"),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("journal-set")
        .setDescription("Creates or updates a journal entry for an exact date")
        .addStringOption((option) =>
          option.setName("date").setDescription("Journal date in YYYY-MM-DD format").setRequired(true),
        )
        .addStringOption((option) =>
          option.setName("prompt").setDescription("Prompt text for that day").setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("journal-delete")
        .setDescription("Deletes the journal entry for an exact date")
        .addStringOption((option) =>
          option.setName("date").setDescription("Journal date in YYYY-MM-DD format").setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName("journal-list").setDescription("Lists upcoming configured journal entries"),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName("journal-export").setDescription("Exports all journal entries as CSV"),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("journal-import")
        .setDescription("Imports journal entries from a CSV file")
        .addAttachmentOption((option) =>
          option.setName("file").setDescription("CSV file with date,prompt columns").setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("journal-show")
        .setDescription("Previews the journal message for a date without linking the message ID")
        .addStringOption((option) =>
          option.setName("date").setDescription("Journal date in YYYY-MM-DD format (defaults to today)"),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("counting-set")
        .setDescription("Sets the current counting channel number")
        .addIntegerOption((option) =>
          option.setName("number").setDescription("The current number to store").setRequired(true),
        ),
    ).addSubcommand((subcommand) =>
      subcommand
        .setName("timezone")
        .setDescription("Set someone's timezone for accurate daily/monthly resets")
        .addUserOption((option) =>
          option.setName("user").setDescription("The user to set the timezone for").setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName("timezone")
            .setDescription("The timezone to set")
            .setRequired(true)
            .setAutocomplete(true),
        ),
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    let roles = Role.PROFESSOR | Role.OWNER;
    if (ALLOWED_PREFECT_COMMANDS.includes(interaction.options.getSubcommand())) {
      roles |= Role.PREFECT;
    }
    if (!inGuild(interaction) || !requireRole(interaction, roles)) return;

    await interaction.deferReply();

    switch (interaction.options.getSubcommand()) {
      case "adjust-points":
        await adjustPoints(interaction);
        break;
      case "reset-monthly-points":
        await resetMonthlyPoints(interaction);
        break;
      case "refresh-ranks":
        await refreshYearRoles(interaction);
        break;
      case "vc-emoji":
        await vcEmojiCommand(interaction);
        break;
      case "check-integrity":
        await checkIntegrity(interaction);
        break;
      case "fix-integrity":
        await fixIntegrity(interaction);
        break;
      case "journal-set":
        await journalSet(interaction);
        break;
      case "journal-delete":
        await journalDelete(interaction);
        break;
      case "journal-list":
        await journalList(interaction);
        break;
      case "journal-export":
        await journalExport(interaction);
        break;
      case "journal-import":
        await journalImport(interaction);
        break;
      case "journal-show":
        await journalShow(interaction);
        break;
      case "counting-set":
        await countingSet(interaction);
        break;
      case "timezone": {
        const user = interaction.options.getUser("user", true);
        await setTimezone(interaction, user.id, `${user.username}'s`, { deferred: true });
        break;
      }
      default:
        await errorReply(interaction, "Invalid Subcommand", "Unknown subcommand.", { deferred: true });
        return;
    }
  },
  async autocomplete(interaction: AutocompleteInteraction) {
    if (interaction.options.getSubcommand() === "timezone") {
      await autocompleteTimezone(interaction);
    }
  },
} as Command;

async function adjustPoints(interaction: ChatInputCommandInteraction<"cached">) {
  const amount = interaction.options.getInteger("amount", true);
  const user = interaction.options.getUser("user", true);
  const reason = interaction.options.getString("reason");

  await awardPoints(db, user.id, amount);

  await db.insert(pointAdjustmentTable).values({
    discordId: user.id,
    adjustedBy: interaction.user.id,
    amount,
    reason,
  });

  log.info("Points adjusted", { user: user.id, amount, reason, adjustedBy: interaction.user.id });
  await interaction.editReply(`Adjusted ${amount} points for ${user.tag}.` + (reason ? ` Reason: ${reason}` : ""));
}

async function resetMonthlyPoints(interaction: ChatInputCommandInteraction<"cached">) {
  const scoreboards = await db.transaction(async (db) => {
    // Snapshot house cup results before resetting
    const [weighted, unweighted, champions] = await Promise.all([
      getWeightedHousePoints(db),
      getUnweightedHousePoints(db),
      // Top scorer per house
      db
        .selectDistinctOn([userTable.house], {
          house: userTable.house,
          discordId: userTable.discordId,
        })
        .from(userTable)
        .where(not(isNull(userTable.house)))
        .orderBy(userTable.house, desc(userTable.monthlyPoints)),
    ]);
    const weightedMap = new Map(weighted.map((h) => [h.house, h]));
    const unweightedMap = new Map(unweighted.map((h) => [h.house, h]));
    const championMap = new Map(champions.map((c) => [c.house, c.discordId]));

    const winner = weighted[0]?.house; // Already sorted desc by totalPoints
    assert(winner, "No house points found during monthly reset");
    const month = dayjs().format("YYYY-MM");

    const [cupMonth] = await db
      .insert(houseCupMonthTable)
      .values({ month, winner })
      .returning({ id: houseCupMonthTable.id });
    assert(cupMonth, "Failed to create house cup month record");

    await db.insert(houseCupEntryTable).values(
      HOUSES.map((house) => {
        const w = weightedMap.get(house);
        const raw = unweightedMap.get(house);
        return {
          monthId: cupMonth.id,
          house,
          weightedPoints: w?.totalPoints ?? 0,
          rawPoints: raw?.totalPoints ?? 0,
          memberCount: raw?.memberCount ?? 0,
          qualifyingCount: w?.memberCount ?? 0,
          champion: championMap.get(house) ?? null,
        };
      }),
    );
    log.info("House cup snapshot saved", { month, winner });

    const result = await db.update(userTable).set({
      monthlyPoints: 0,
      monthlyVoiceTime: 0,
      announcedYear: 0,
    });
    log.info("Monthly reset complete", { usersReset: result.rowCount });

    // Store reset timestamp
    await setMonthStartDate(new Date(), db);
    return await db.select().from(houseScoreboardTable);
  });
  await updateScoreboardMessages(await getHousepointMessages(db, scoreboards));

  // Refresh year roles in background (removes all year roles since voice time is 0)
  void refreshAllYearRoles(interaction.guild).then((count) => {
    log.info("Year roles refreshed", { usersUpdated: count });
  });
  await interaction.editReply("Monthly points have been reset for all users.");
}

async function refreshYearRoles(interaction: ChatInputCommandInteraction<"cached">) {
  await wrapWithAlerting(async () => {
    const count = await refreshAllYearRoles(interaction.guild);
    await interaction.editReply(`Year Ranks refreshed for ${count} users.`);
  }, "Refresh Year Ranks processing");
}

async function vcEmojiCommand(interaction: ChatInputCommandInteraction<"cached">) {
  const emoji = interaction.options.getString("emoji");
  if (emoji) {
    const oldEmoji = await getVCEmoji();
    await setVCEmoji(emoji);
    log.info("VC emoji set", { emoji });

    if (oldEmoji !== emoji) {
      const voiceMembers = interaction.guild.members.cache.filter((m) => m.voice.channel !== null);
      await Promise.all(
        voiceMembers.map(async (member) => {
          if (!member.nickname?.includes(oldEmoji)) return;
          const newNickname = member.nickname.replaceAll(oldEmoji, emoji).trim();
          if (newNickname.length > 32 || newNickname === member.nickname) return;
          await updateMember({ member, reason: "Swapping VC emoji", nickname: newNickname });
        }),
      );
      log.info("Swapped VC emoji for voice members", { count: voiceMembers.size });
    }

    await interaction.editReply(`Voice channel emoji set to: ${emoji}`);
  } else {
    const currentEmoji = await getVCEmoji();
    log.debug("VC emoji fetched", { emoji: currentEmoji });
    await interaction.editReply(`Current voice channel emoji: ${currentEmoji}`);
  }
}


async function countingSet(interaction: ChatInputCommandInteraction<"cached">) {
  const count = interaction.options.getInteger("number", true);
  await db.transaction(async (tx) => {
    await setCountingState({ count }, tx);
  });

  log.info("Counting value set", { count, userId: interaction.user.id });
  await interaction.editReply(`Current counting value set to ${count}.`);
}

interface ExpectedValues {
  totalPoints: number;
  monthlyPoints: number;
  dailyPoints: number;
  totalVoiceTime: number;
  monthlyVoiceTime: number;
  dailyVoiceTime: number;
}

async function computeExpectedValues() {
  const monthStartDate = await getMonthStartDate();

  // Get all users with their stored points and voice time
  const users = await db.select().from(userTable);

  // Get all voice sessions with timestamps (tracked ones for points, all closed for time)
  const voiceSessions = await db
    .select({
      discordId: voiceSessionTable.discordId,
      points: voiceSessionTable.points,
      duration: voiceSessionTable.duration,
      leftAt: voiceSessionTable.leftAt,
    })
    .from(voiceSessionTable)
    .where(eq(voiceSessionTable.isTracked, true));

  // Get all approved submissions with timestamps
  const submissions = await db
    .select({
      discordId: submissionTable.discordId,
      points: submissionTable.points,
      reviewedAt: submissionTable.reviewedAt,
    })
    .from(submissionTable)
    .where(eq(submissionTable.status, "APPROVED"));

  // Get all point adjustments with timestamps
  const adjustments = await db
    .select({
      discordId: pointAdjustmentTable.discordId,
      amount: pointAdjustmentTable.amount,
      createdAt: pointAdjustmentTable.createdAt,
    })
    .from(pointAdjustmentTable);

  // Build aggregated maps per user
  const voicePointsMap = new Map<string, Sums>();
  const voiceTimeMap = new Map<string, Sums>();
  const submissionMap = new Map<string, Sums>();
  const adjustmentMap = new Map<string, Sums>();

  // Initialize maps for all users
  for (const user of users) {
    voicePointsMap.set(user.discordId, { total: 0, monthly: 0, daily: 0 });
    voiceTimeMap.set(user.discordId, { total: 0, monthly: 0, daily: 0 });
    submissionMap.set(user.discordId, { total: 0, monthly: 0, daily: 0 });
    adjustmentMap.set(user.discordId, { total: 0, monthly: 0, daily: 0 });
  }

  // Create lookup for user reset times
  const userResetMap = new Map(users.map((u) => [u.discordId, u.lastDailyReset]));

  // Aggregate voice sessions (only tracked sessions count for both points and time)
  for (const vs of voiceSessions) {
    const resetTime = userResetMap.get(vs.discordId);

    // Aggregate points
    if (vs.points !== null) {
      const pointSums = voicePointsMap.get(vs.discordId);
      if (pointSums) {
        pointSums.total += vs.points;
        if (vs.leftAt && vs.leftAt >= monthStartDate) pointSums.monthly += vs.points;
        if (vs.leftAt && resetTime && vs.leftAt >= resetTime) pointSums.daily += vs.points;
      }
    }

    // Aggregate voice time
    if (vs.duration !== null) {
      const timeSums = voiceTimeMap.get(vs.discordId);
      if (timeSums) {
        timeSums.total += vs.duration;
        if (vs.leftAt && vs.leftAt >= monthStartDate) timeSums.monthly += vs.duration;
        if (vs.leftAt && resetTime && vs.leftAt >= resetTime) timeSums.daily += vs.duration;
      }
    }
  }

  // Aggregate submissions
  for (const sub of submissions) {
    const sums = submissionMap.get(sub.discordId);
    if (!sums) continue;
    sums.total += sub.points;
    if (sub.reviewedAt && sub.reviewedAt >= monthStartDate) sums.monthly += sub.points;
    const resetTime = userResetMap.get(sub.discordId);
    if (sub.reviewedAt && resetTime && sub.reviewedAt >= resetTime) sums.daily += sub.points;
  }

  // Aggregate adjustments
  for (const adj of adjustments) {
    const sums = adjustmentMap.get(adj.discordId);
    if (!sums) continue;
    sums.total += adj.amount;
    if (adj.createdAt >= monthStartDate) sums.monthly += adj.amount;
    const resetTime = userResetMap.get(adj.discordId);
    if (resetTime && adj.createdAt >= resetTime) sums.daily += adj.amount;
  }

  const zero = { total: 0, monthly: 0, daily: 0 };
  const expectedMap = new Map<string, ExpectedValues>();

  for (const user of users) {
    const vcPts = voicePointsMap.get(user.discordId) ?? zero;
    const vcTime = voiceTimeMap.get(user.discordId) ?? zero;
    const sub = submissionMap.get(user.discordId) ?? zero;
    const adj = adjustmentMap.get(user.discordId) ?? zero;

    expectedMap.set(user.discordId, {
      totalPoints: vcPts.total + sub.total + adj.total,
      monthlyPoints: vcPts.monthly + sub.monthly + adj.monthly,
      dailyPoints: vcPts.daily + sub.daily + adj.daily,
      totalVoiceTime: vcTime.total,
      monthlyVoiceTime: vcTime.monthly,
      dailyVoiceTime: vcTime.daily,
    });
  }

  return { users, expectedMap, voicePointsMap, submissionMap, adjustmentMap, voiceTimeMap };
}

async function checkIntegrity(interaction: ChatInputCommandInteraction<"cached">) {
  const { users, expectedMap, voicePointsMap, submissionMap, adjustmentMap } = await computeExpectedValues();

  const discrepancies: string[] = [];
  const zero = { total: 0, monthly: 0, daily: 0 };

  for (const user of users) {
    const expected = expectedMap.get(user.discordId);
    if (!expected) continue;
    const vcPts = voicePointsMap.get(user.discordId) ?? zero;
    const sub = submissionMap.get(user.discordId) ?? zero;
    const adj = adjustmentMap.get(user.discordId) ?? zero;

    if (user.totalPoints !== expected.totalPoints) {
      discrepancies.push(
        `**${user.username}** totalPts: stored=${user.totalPoints}, expected=${expected.totalPoints} (vc=${vcPts.total}, sub=${sub.total}, adj=${adj.total})`,
      );
    }
    if (user.monthlyPoints !== expected.monthlyPoints) {
      discrepancies.push(
        `**${user.username}** monthlyPts: stored=${user.monthlyPoints}, expected=${expected.monthlyPoints} (vc=${vcPts.monthly}, sub=${sub.monthly}, adj=${adj.monthly})`,
      );
    }
    if (user.dailyPoints !== expected.dailyPoints) {
      discrepancies.push(
        `**${user.username}** dailyPts: stored=${user.dailyPoints}, expected=${expected.dailyPoints} (vc=${vcPts.daily}, sub=${sub.daily}, adj=${adj.daily})`,
      );
    }

    if (user.totalVoiceTime !== expected.totalVoiceTime) {
      discrepancies.push(
        `**${user.username}** totalVcTime: stored=${user.totalVoiceTime}, expected=${expected.totalVoiceTime}`,
      );
    }
    if (user.monthlyVoiceTime !== expected.monthlyVoiceTime) {
      discrepancies.push(
        `**${user.username}** monthlyVcTime: stored=${user.monthlyVoiceTime}, expected=${expected.monthlyVoiceTime}`,
      );
    }
    if (user.dailyVoiceTime !== expected.dailyVoiceTime) {
      discrepancies.push(
        `**${user.username}** dailyVcTime: stored=${user.dailyVoiceTime}, expected=${expected.dailyVoiceTime}`,
      );
    }
  }

  log.info("Integrity check complete", { discrepancies: discrepancies.length });

  if (discrepancies.length === 0) {
    await interaction.editReply("✅ No discrepancies found.");
  } else {
    const message = `⚠️ Found ${discrepancies.length} discrepancies:\n${discrepancies.slice(0, 20).join("\n")}${discrepancies.length > 20 ? `\n...and ${discrepancies.length - 20} more` : ""}`;
    await interaction.editReply(message);
  }
}

async function fixIntegrity(interaction: ChatInputCommandInteraction<"cached">) {
  const { users, expectedMap } = await computeExpectedValues();

  let fixed = 0;
  for (const user of users) {
    const expected = expectedMap.get(user.discordId);
    if (!expected) continue;

    const needsFix =
      user.totalPoints !== expected.totalPoints ||
      user.monthlyPoints !== expected.monthlyPoints ||
      user.dailyPoints !== expected.dailyPoints ||
      user.totalVoiceTime !== expected.totalVoiceTime ||
      user.monthlyVoiceTime !== expected.monthlyVoiceTime ||
      user.dailyVoiceTime !== expected.dailyVoiceTime;

    if (needsFix) {
      await db
        .update(userTable)
        .set({
          totalPoints: expected.totalPoints,
          monthlyPoints: expected.monthlyPoints,
          dailyPoints: expected.dailyPoints,
          totalVoiceTime: expected.totalVoiceTime,
          monthlyVoiceTime: expected.monthlyVoiceTime,
          dailyVoiceTime: expected.dailyVoiceTime,
        })
        .where(eq(userTable.discordId, user.discordId));
      fixed++;
    }
  }

  log.info("Integrity fix complete", { usersFixed: fixed });
  await interaction.editReply(fixed === 0 ? "No discrepancies found." : `Fixed ${fixed} user(s).`);
}
