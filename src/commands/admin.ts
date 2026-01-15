import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import { db, getVCEmoji, setMonthStartDate, setVCEmoji } from "../db/db.ts";
import { awardPoints } from "../services/pointsService.ts";
import { errorReply, inGuild, requireRole } from "../utils/interactionUtils.ts";
import { wrapWithAlerting } from "../utils/alerting.ts";
import { pointAdjustmentTable, userTable } from "../db/schema.ts";
import { Role } from "../utils/constants.ts";
import { refreshAllYearRoles } from "../utils/yearRoleUtils.ts";
import { createLogger } from "../utils/logger.ts";
import type { CommandOptions } from "../types.ts";

const log = createLogger("Admin");

export default {
  data: new SlashCommandBuilder()
    .setName("admin")
    .setDescription("Admin commands")
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
      subcommand.setName("reset-total-points").setDescription("Resets total points for all users"),
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
    ),

  async execute(interaction: ChatInputCommandInteraction, { opId }: CommandOptions): Promise<void> {
    if (!inGuild(interaction, opId) || !requireRole(interaction, opId, Role.PROFESSOR)) return;
    await interaction.deferReply();

    switch (interaction.options.getSubcommand()) {
      case "adjust-points":
        await adjustPoints(interaction, opId);
        break;
      case "reset-monthly-points":
        await resetMonthlyPoints(interaction, opId);
        break;
      case "reset-total-points":
        await resetTotalPoints(interaction, opId);
        break;
      case "refresh-ranks":
        await refreshYearRoles(interaction, opId);
        break;
      case "vc-emoji":
        await vcEmojiCommand(interaction, opId);
        break;
      default:
        await errorReply(opId, interaction, "Invalid Subcommand", "Unknown subcommand.", { deferred: true });
        return;
    }
  },
};

async function adjustPoints(interaction: ChatInputCommandInteraction<"cached">, opId: string) {
  const amount = interaction.options.getInteger("amount", true);
  const user = interaction.options.getUser("user", true);
  const reason = interaction.options.getString("reason");

  await awardPoints(db, user.id, amount, opId);

  await db.insert(pointAdjustmentTable).values({
    discordId: user.id,
    adjustedBy: interaction.user.id,
    amount,
    reason,
  });

  log.info("Points adjusted", { opId, user: user.id, amount, reason, adjustedBy: interaction.user.id });
  await interaction.editReply(`Adjusted ${amount} points for ${user.tag}.`);
}

async function resetMonthlyPoints(interaction: ChatInputCommandInteraction<"cached">, opId: string) {
  await wrapWithAlerting(
    async () => {
      const result = await db.update(userTable).set({
        monthlyPoints: 0,
        monthlyVoiceTime: 0,
        announcedYear: 0,
      });
      log.info("Monthly reset complete", { opId, usersReset: result.rowCount });

      // Refresh year roles after resetting (removes all year roles since voice time is 0)
      const rolesUpdated = await refreshAllYearRoles(interaction.guild);
      log.info("Year roles refreshed", { opId, usersUpdated: rolesUpdated });

      // Store reset timestamp
      await setMonthStartDate(new Date());
    },
    "Monthly reset processing",
    opId,
  );
  await interaction.editReply("Monthly points have been reset for all users.");
}

async function resetTotalPoints(interaction: ChatInputCommandInteraction<"cached">, opId: string) {
  await wrapWithAlerting(
    async () => {
      const result = await db.update(userTable).set({
        totalPoints: 0,
        totalVoiceTime: 0,
      });
      log.info("Total reset complete", { opId, usersReset: result.rowCount });
    },
    "Total reset processing",
    opId,
  );
  await interaction.editReply("Total points have been reset for all users.");
}

async function refreshYearRoles(interaction: ChatInputCommandInteraction<"cached">, opId: string) {
  await wrapWithAlerting(
    async () => {
      const count = await refreshAllYearRoles(interaction.guild);
      await interaction.editReply(`Year Ranks refreshed for ${count} users.`);
    },
    "Refresh Year Ranks processing",
    opId,
  );
}

async function vcEmojiCommand(interaction: ChatInputCommandInteraction<"cached">, opId: string) {
  const emoji = interaction.options.getString("emoji");
  if (emoji) {
    await setVCEmoji(emoji);
    log.info("VC emoji set", { opId, emoji });
    await interaction.editReply(`Voice channel emoji set to: ${emoji}`);
  } else {
    const currentEmoji = await getVCEmoji();
    log.debug("VC emoji fetched", { opId, emoji: currentEmoji });
    await interaction.editReply(`Current voice channel emoji: ${currentEmoji}`);
  }
}
