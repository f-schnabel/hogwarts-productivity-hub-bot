import { ChatInputCommandInteraction, GuildMember, SlashCommandBuilder } from "discord.js";
import { db } from "../db/db.ts";
import { awardPoints, isPrefectOrProfessor, replyError } from "../utils/utils.ts";
import { wrapWithAlerting } from "../utils/alerting.ts";
import { userTable } from "../db/schema.ts";

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
    ),
  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply();
    const member = interaction.member as GuildMember;

    if (!isPrefectOrProfessor(member)) {
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
      default:
        await replyError(interaction, "Invalid Subcommand", "Please use `/admin adjust-points`.");
        return;
    }
  },
};

async function adjustPoints(interaction: ChatInputCommandInteraction) {
  const amount = interaction.options.getInteger("amount", true);
  const user = interaction.options.getUser("user", true);

  await awardPoints(db, user.id, amount);
}

async function resetMonthlyPoints(interaction: ChatInputCommandInteraction) {
  await wrapWithAlerting(async () => {
    const result = await db.update(userTable).set({
      monthlyPoints: 0,
      monthlyVoiceTime: 0,
    });
    console.log("Monthly reset edited this many users:", result.rowCount);
  }, "Monthly reset processing");
  await interaction.editReply("Monthly points have been reset for all users.");
}
