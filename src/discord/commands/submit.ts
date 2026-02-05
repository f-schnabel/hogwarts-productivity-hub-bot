import {
  ButtonInteraction,
  ButtonStyle,
  channelMention,
  ChatInputCommandInteraction,
  ComponentType,
  EmbedBuilder,
  GuildMember,
  MessageFlags,
  SlashCommandBuilder,
  TextInputStyle,
  time,
  userMention,
  type InteractionReplyOptions,
} from "discord.js";
import dayjs from "dayjs";
import { awardPoints } from "@/services/pointsService.ts";
import { getHouseFromMember } from "@/discord/utils/houseUtils.ts";
import { hasAnyRole } from "@/discord/utils/roleUtils.ts";
import { errorReply, inGuild } from "@/discord/utils/interactionUtils.ts";
import assert from "node:assert";
import { db } from "@/db/db.ts";
import { submissionTable, userTable } from "@/db/schema.ts";
import { eq, sql } from "drizzle-orm";
import { DEFAULT_SUBMISSION_POINTS, Role, SUBMISSION_COLORS } from "@/common/constants.ts";
import type { CommandOptions } from "@/common/types.ts";

const SUBMISSION_CHANNEL_IDS = process.env.SUBMISSION_CHANNEL_IDS.split(",");

export default {
  data: new SlashCommandBuilder()
    .setName("submit")
    .setDescription("Submit a score")
    .addAttachmentOption((option) =>
      option.setName("screenshot").setDescription("A screenshot of your work").setRequired(true),
    ),

  /**
   * Submit a score for approval.
   * Does not use deferReply as the initial processing is quick.
   */
  async execute(interaction: ChatInputCommandInteraction, { opId }: CommandOptions): Promise<void> {
    if (!inGuild(interaction, opId)) return;

    if (!hasAnyRole(interaction.member, Role.OWNER) && !SUBMISSION_CHANNEL_IDS.includes(interaction.channelId)) {
      await errorReply(
        opId,
        interaction,
        "Invalid Channel",
        `You can use this command in the following channel${SUBMISSION_CHANNEL_IDS.length > 1 ? "s" : ""}: ${SUBMISSION_CHANNEL_IDS.map((id) => channelMention(id)).join(", ")}.`,
      );

      return;
    }

    const screenshot = interaction.options.getAttachment("screenshot", true);

    const house = getHouseFromMember(interaction.member);
    assert(house, "User does not have a house role assigned");

    const [submission] = await db
      .insert(submissionTable)
      .values({
        discordId: interaction.member.id,
        points: DEFAULT_SUBMISSION_POINTS,
        screenshotUrl: screenshot.url,
        house: house,
        // Calculate next house submission ID by counting existing submissions
        houseId: sql`(SELECT COUNT(*) + 1 FROM ${submissionTable} WHERE ${submissionTable.house} = ${house})`,
      })
      .returning();
    assert(submission, "Failed to create submission");

    // Fetch user's timezone for display
    const user = await db.query.userTable.findFirst({
      columns: { timezone: true },
      where: eq(userTable.discordId, interaction.member.id),
    });
    const userTimezone = user?.timezone ?? "UTC";

    await interaction.reply(submissionMessage(submission, userTimezone));
  },

  async buttonHandler(
    interaction: ButtonInteraction,
    event: string,
    submissionId: string | undefined,
    opId: string,
  ): Promise<void> {
    const member = interaction.member as GuildMember;
    if (!hasAnyRole(member, Role.PREFECT)) {
      await interaction.reply({
        content: "You do not have permission to perform this action.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    assert(submissionId, "No data provided in button interaction");

    let reason: string | undefined = undefined;

    if (event === "reject") {
      await interaction.showModal({
        title: "Reject Submission",
        customId: `rejectModal-${submissionId}`,
        components: [
          {
            type: ComponentType.ActionRow,
            components: [
              {
                type: ComponentType.TextInput,
                style: TextInputStyle.Short,
                customId: "reasonInput",
                label: "Please provide a reason for rejection:",
                required: true,
              },
            ],
          },
        ],
      });

      try {
        const modalResponse = await interaction.awaitModalSubmit({
          filter: (i) => i.customId === `rejectModal-${submissionId}` && i.user.id === interaction.user.id,
          time: 60000,
        });
        reason = modalResponse.fields.getTextInputValue("reasonInput");
        await modalResponse.deferUpdate();
      } catch {
        return;
      }
    } else {
      await interaction.deferUpdate();
    }

    const [submission] = await db
      .update(submissionTable)
      .set({ status: event === "approve" ? "APPROVED" : "REJECTED", reviewedAt: new Date(), reviewedBy: member.id })
      .where(eq(submissionTable.id, Number.parseInt(submissionId)))
      .returning();

    assert(submission, `Failed to update submission with ID ${submissionId}`);

    // Fetch the submitter's timezone for display
    const submitter = await db.query.userTable.findFirst({
      columns: { timezone: true },
      where: eq(userTable.discordId, submission.discordId),
    });
    const userTimezone = submitter?.timezone ?? "UTC";

    await interaction.message.fetch().then((m) => m.edit(submissionMessage(submission, userTimezone, reason)));

    if (event === "approve") {
      await awardPoints(db, submission.discordId, submission.points, opId);
    }
  },
};

function submissionMessage(submissionData: typeof submissionTable.$inferSelect, userTimezone: string, reason?: string) {
  let components: InteractionReplyOptions["components"] = [];
  if (submissionData.status === "PENDING") {
    components = [
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.Button,
            customId: `submit|approve|${submissionData.id}`,
            label: `Approve ${submissionData.points} points`,
            style: ButtonStyle.Success,
          },
          {
            type: ComponentType.Button,
            customId: `submit|reject|${submissionData.id}`,
            label: "Reject",
            style: ButtonStyle.Secondary,
          },
        ],
      },
    ];
  }

  // Format the submitted time in the user's timezone
  const formattedSubmittedAt = dayjs(submissionData.submittedAt).tz(userTimezone).format("h:mm:ss A [on] MMM D (z)");

  const embed = new EmbedBuilder({
    title: submissionData.house.toUpperCase(),
    color: SUBMISSION_COLORS[submissionData.status],
    fields: [
      {
        name: "Submission ID",
        value: `${submissionData.houseId}`,
        inline: false,
      },
      {
        name: "Player",
        value: userMention(submissionData.discordId),
        inline: true,
      },
      {
        name: "Score",
        value: `${submissionData.points}`,
        inline: true,
      },
      {
        name: "Submitted by",
        value: `${userMention(submissionData.discordId)} at ${formattedSubmittedAt}`,
        inline: false,
      },
    ],
    image: {
      url: submissionData.screenshotUrl,
    },
  });

  if (submissionData.status === "APPROVED") {
    embed.addFields({
      name: "Approved by",
      value: `${userMention(submissionData.reviewedBy ?? "")} at ${time(submissionData.reviewedAt ?? new Date())}`,
      inline: false,
    });
  } else if (submissionData.status === "REJECTED") {
    assert(reason, "Rejection reason must be provided for rejected submissions");
    embed.addFields({
      name: "Rejected by",
      value: `${userMention(submissionData.reviewedBy ?? "")} at ${time(submissionData.reviewedAt ?? new Date())}`,
      inline: false,
    });
    embed.addFields({
      name: "Reason",
      value: reason,
      inline: false,
    });
  }

  return {
    embeds: [embed],
    components: components,
  };
}
