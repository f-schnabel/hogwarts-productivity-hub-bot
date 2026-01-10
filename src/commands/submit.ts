import {
  ButtonInteraction,
  ButtonStyle,
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
import { awardPoints } from "../services/pointsService.ts";
import { getHouseFromMember } from "../utils/houseUtils.ts";
import { hasAnyRole } from "../utils/roleUtils.ts";
import { replyError } from "../utils/interactionUtils.ts";
import assert from "node:assert";
import { db } from "../db/db.ts";
import { submissionTable } from "../db/schema.ts";
import { count, eq } from "drizzle-orm";
import { DEFAULT_SUBMISSION_POINTS, Role, SUBMISSION_COLORS } from "../utils/constants.ts";
import type { CommandOptions } from "../types.ts";

const SUBMISSION_CHANNEL_IDS = process.env.SUBMISSION_CHANNEL_IDS.split(",");

export default {
  data: new SlashCommandBuilder()
    .setName("submit")
    .setDescription("Submit a score")
    .addAttachmentOption((option) =>
      option.setName("screenshot").setDescription("A screenshot of your work").setRequired(true),
    )
    .addIntegerOption((option) =>
      option.setName("points").setDescription(`The number of points to submit (default: ${DEFAULT_SUBMISSION_POINTS})`),
    ),

  async execute(interaction: ChatInputCommandInteraction, { opId }: CommandOptions): Promise<void> {
    const member = interaction.member as GuildMember;
    await interaction.deferReply();
    if (!hasAnyRole(member, Role.OWNER) && !SUBMISSION_CHANNEL_IDS.includes(interaction.channelId)) {
      await replyError(opId, interaction, "Invalid Channel", "You cannot use this command in this channel.");
      return;
    }
    const points = interaction.options.getInteger("points") ?? DEFAULT_SUBMISSION_POINTS;
    const screenshot = interaction.options.getAttachment("screenshot", true);
    const house = getHouseFromMember(member);
    assert(house, "User does not have a house role assigned");
    const submission = await db.transaction(async (db) => {
      const [houseId] = await db
        .select({ value: count() })
        .from(submissionTable)
        .where(eq(submissionTable.house, house));
      assert(houseId, "Failed to retrieve house submission count");

      const [submission] = await db
        .insert(submissionTable)
        .values({
          discordId: member.id,
          points,
          screenshotUrl: screenshot.url,
          house: house,
          houseId: houseId.value + 1,
        })
        .returning();
      assert(submission, "Failed to create submission");
      return submission;
    });

    await interaction.editReply(submissionMessage(submission));
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

    await interaction.message.fetch().then((m) => m.edit(submissionMessage(submission, reason)));

    if (event === "approve") {
      await awardPoints(db, submission.discordId, submission.points, opId);
    }
  },
};

function submissionMessage(submissionData: typeof submissionTable.$inferSelect, reason?: string) {
  let components: InteractionReplyOptions["components"] = [];
  if (submissionData.status === "PENDING") {
    components = [
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.Button,
            customId: "submit|approve|" + submissionData.id.toFixed(),
            label: `Approve ${submissionData.points} points`,
            style: ButtonStyle.Success,
          },
          {
            type: ComponentType.Button,
            customId: "submit|reject|" + submissionData.id.toFixed(),
            label: "Reject",
            style: ButtonStyle.Secondary,
          },
        ],
      },
    ];
  }

  const embed = new EmbedBuilder({
    title: submissionData.house.toUpperCase(),
    color: SUBMISSION_COLORS[submissionData.status],
    fields: [
      {
        name: "Submission ID",
        value: submissionData.houseId.toFixed(),
        inline: false,
      },
      {
        name: "Player",
        value: userMention(submissionData.discordId),
        inline: true,
      },
      {
        name: "Score",
        value: submissionData.points.toFixed(),
        inline: true,
      },
      {
        name: "Submitted by",
        value: `${userMention(submissionData.discordId)} at ${time(submissionData.submittedAt)}`,
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
