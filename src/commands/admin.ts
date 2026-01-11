import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import { db } from "../db/db.ts";
import { awardPoints } from "../services/pointsService.ts";
import { errorReply, requireRole } from "../utils/interactionUtils.ts";
import { wrapWithAlerting } from "../utils/alerting.ts";
import { settingsTable, userTable } from "../db/schema.ts";
import { Role, SETTINGS_KEYS } from "../utils/constants.ts";
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
        ),
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
    ),

  async execute(interaction: ChatInputCommandInteraction, { opId }: CommandOptions): Promise<void> {
    if (!interaction.inCachedGuild()) {
      await errorReply(opId, interaction, "Invalid Context", "This command can only be used in a server.");
      return;
    }
    await interaction.deferReply();
    if (!(await requireRole(interaction, opId, Role.PROFESSOR))) return;

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
      default:
        await errorReply(opId, interaction, "Invalid Subcommand", "Unknown subcommand.", { deferred: true });
        return;
    }
  },
};

async function adjustPoints(interaction: ChatInputCommandInteraction<"cached">, opId: string) {
  const amount = interaction.options.getInteger("amount", true);
  const user = interaction.options.getUser("user", true);

  await awardPoints(db, user.id, amount, opId);

  await interaction.editReply(`Adjusted ${amount} points for ${user.tag}.`);
}

async function resetMonthlyPoints(interaction: ChatInputCommandInteraction<"cached">, opId: string) {
  await wrapWithAlerting(
    async () => {
      const result = await db.update(userTable).set({
        monthlyPoints: 0,
        monthlyVoiceTime: 0,
      });
      log.info("Monthly reset complete", { opId, usersReset: result.rowCount });

      // Refresh year roles after resetting (removes all year roles since voice time is 0)
      const rolesUpdated = await refreshAllYearRoles(interaction.guild, opId);
      log.info("Year roles refreshed", { opId, usersUpdated: rolesUpdated });

      // Store reset timestamp
      await db
        .insert(settingsTable)
        .values({ key: SETTINGS_KEYS.LAST_MONTHLY_RESET, value: new Date().toISOString() })
        .onConflictDoUpdate({
          target: settingsTable.key,
          set: { value: new Date().toISOString() },
        });
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
      const count = await refreshAllYearRoles(interaction.guild, opId);
      await interaction.editReply(`Year Ranks refreshed for ${count} users.`);
    },
    "Refresh Year Ranks processing",
    opId,
  );
}
