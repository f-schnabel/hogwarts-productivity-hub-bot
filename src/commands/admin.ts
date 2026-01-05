import { ChatInputCommandInteraction, GuildMember, SlashCommandBuilder } from "discord.js";
import { db } from "../db/db.ts";
import { awardPoints, hasAnyRole, replyError, Role } from "../utils/utils.ts";
import { wrapWithAlerting } from "../utils/alerting.ts";
import { settingsTable, userTable } from "../db/schema.ts";
import { SETTINGS_KEYS } from "../utils/constants.ts";
import { refreshAllYearRoles } from "../utils/yearRoleUtils.ts";
import { createLogger } from "../utils/logger.ts";

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
  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply();
    const member = interaction.member as GuildMember;

    if (!hasAnyRole(member, Role.PROFESSOR)) {
      await replyError(interaction, "Insufficient Permissions", "You do not have permission to use this command.");
      return;
    }

    switch (interaction.options.getSubcommand()) {
      case "adjust-points":
        await adjustPoints(interaction);
        break;
      case "reset-monthly-points":
        await resetMonthlyPoints(interaction);
        break;
      case "reset-total-points":
        await resetTotalPoints(interaction);
        break;
      case "refresh-ranks":
        await refreshYearRoles(interaction);
        break;
      default:
        await replyError(interaction, "Invalid Subcommand", "Unknown subcommand.");
        return;
    }
  },
};

async function adjustPoints(interaction: ChatInputCommandInteraction) {
  const amount = interaction.options.getInteger("amount", true);
  const user = interaction.options.getUser("user", true);

  await awardPoints(db, user.id, amount);

  await interaction.editReply(`Adjusted ${amount} points for ${user.tag}.`);
}

async function resetMonthlyPoints(interaction: ChatInputCommandInteraction) {
  const guild = interaction.guild;
  if (!guild) {
    await replyError(interaction, "Error", "This command can only be used in a server.");
    return;
  }

  await wrapWithAlerting(async () => {
    const result = await db.update(userTable).set({
      monthlyPoints: 0,
      monthlyVoiceTime: 0,
    });
    log.info("Monthly reset complete", { opId: "admin", usersReset: result.rowCount });

    // Refresh year roles after resetting (removes all year roles since voice time is 0)
    const rolesUpdated = await refreshAllYearRoles(guild);
    log.info("Year roles refreshed", { opId: "admin", usersUpdated: rolesUpdated });

    // Store reset timestamp
    await db
      .insert(settingsTable)
      .values({ key: SETTINGS_KEYS.LAST_MONTHLY_RESET, value: new Date().toISOString() })
      .onConflictDoUpdate({
        target: settingsTable.key,
        set: { value: new Date().toISOString() },
      });
  }, "Monthly reset processing");
  await interaction.editReply("Monthly points have been reset for all users.");
}

async function resetTotalPoints(interaction: ChatInputCommandInteraction) {
  await wrapWithAlerting(async () => {
    const result = await db.update(userTable).set({
      totalPoints: 0,
      totalVoiceTime: 0,
    });
    log.info("Total reset complete", { opId: "admin", usersReset: result.rowCount });
  }, "Total reset processing");
  await interaction.editReply("Total points have been reset for all users.");
}

async function refreshYearRoles(interaction: ChatInputCommandInteraction) {
  const guild = interaction.guild;
  if (!guild) {
    await replyError(interaction, "Error", "This command can only be used in a server.");
    return;
  }

  await wrapWithAlerting(async () => {
    const count = await refreshAllYearRoles(guild);
    await interaction.editReply(`Year Ranks refreshed for ${count} users.`);
  }, "Refresh Year Ranks processing");
}
