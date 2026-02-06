import {
  ButtonInteraction,
  ButtonStyle,
  channelMention,
  ChatInputCommandInteraction,
  ComponentType,
  EmbedBuilder,
  GuildMember,
  MessageFlags,
  messageLink,
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
import { and, eq, gte, lt, or, sql } from "drizzle-orm";
import { DEFAULT_SUBMISSION_POINTS, Role, SUBMISSION_COLORS } from "@/common/constants.ts";
import type { CommandOptions } from "@/common/types.ts";
import { alertOwner } from "../utils/alerting.ts";

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

    // Fetch user's timezone for validation and display
    const userTimezone = await db.query.userTable
      .findFirst({
        columns: { timezone: true },
        where: eq(userTable.discordId, interaction.member.id),
      })
      .then((u) => u?.timezone ?? "UTC");

    // Link to first approved submission if this is the 2nd submission
    const linkedSubmission = await getLinkedSubmissionToday(interaction.member.id, userTimezone);

    const [submission] = await db
      .insert(submissionTable)
      .values({
        discordId: interaction.member.id,
        points: DEFAULT_SUBMISSION_POINTS,
        screenshotUrl: screenshot.url,
        house: house,
        linkedSubmissionId: linkedSubmission?.id ?? null,
        // Calculate next house submission ID by counting existing submissions
        houseId: sql`(SELECT COUNT(*) + 1 FROM ${submissionTable} WHERE ${submissionTable.house} = ${house})`,
      })
      .returning();
    assert(submission, "Failed to create submission");

    // Send the reply and capture message ID for future cross-referencing
    const response = await interaction.reply({
      ...submissionMessage({ submission, userTimezone, linkedSubmission }),
      withResponse: true,
    });
    const reply = response.resource?.message;
    assert(reply, "Failed to get message from reply");

    // Update the submission with the message ID and channel ID
    await db
      .update(submissionTable)
      .set({
        messageId: reply.id,
        channelId: reply.channelId,
      })
      .where(eq(submissionTable.id, submission.id));

    // If linked to a previous submission, update that message with cross-reference
    if (linkedSubmission?.channelId && linkedSubmission.messageId) {
      try {
        const channel = await interaction.client.channels.fetch(linkedSubmission.channelId);
        if (channel?.isTextBased()) {
          const linkedMessage = await channel.messages.fetch(linkedSubmission.messageId);
          await linkedMessage.edit(
            submissionMessage({
              submission: linkedSubmission,
              userTimezone,
              linkedSubmission: {
                channelId: reply.channelId,
                messageId: reply.id,
              },
            }),
          );
        }
      } catch (error) {
        // If we can't update the linked message, continue silently
        await alertOwner(
          `Failed to update linked submission message for submission ID ${linkedSubmission.id} error: ${error instanceof Error ? error.message : "Unknown Error"}`,
          opId,
        );
      }
    }
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

    // Find linked submission (either this links to another, or another links to this)
    const linkedSubmission = await db.query.submissionTable.findFirst({
      columns: { channelId: true, messageId: true },
      where: or(
        submission.linkedSubmissionId ? eq(submissionTable.id, submission.linkedSubmissionId) : undefined,
        eq(submissionTable.linkedSubmissionId, submission.id),
      ),
    });

    await interaction.message
      .fetch()
      .then((m) => m.edit(submissionMessage({ submission, userTimezone, reason, linkedSubmission })));

    if (event === "approve") {
      await awardPoints(db, submission.discordId, submission.points, opId);
    }
  },
};

async function getLinkedSubmissionToday(discordId: string, userTimezone: string) {
  const dayStart = dayjs().tz(userTimezone).startOf("day").toDate();
  const dayEnd = dayjs().tz(userTimezone).endOf("day").toDate();

  const result = await db.query.submissionTable.findMany({
    where: and(
      eq(submissionTable.discordId, discordId),
      gte(submissionTable.submittedAt, dayStart),
      lt(submissionTable.submittedAt, dayEnd),
      eq(submissionTable.status, "APPROVED"),
    ),
  });
  return result.length == 1 ? result[0] : null;
}

interface SubmissionMessageParams {
  submission: typeof submissionTable.$inferSelect;
  userTimezone: string;
  reason?: string;
  linkedSubmission: { channelId: string | null; messageId: string | null } | null | undefined;
}

function submissionMessage({ submission, userTimezone, reason, linkedSubmission }: SubmissionMessageParams) {
  let components: InteractionReplyOptions["components"] = [];
  if (submission.status === "PENDING") {
    components = [
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.Button,
            customId: `submit|approve|${submission.id}`,
            label: `Approve ${submission.points} points`,
            style: ButtonStyle.Success,
          },
          {
            type: ComponentType.Button,
            customId: `submit|reject|${submission.id}`,
            label: "Reject",
            style: ButtonStyle.Secondary,
          },
        ],
      },
    ];
  }

  // Format the submitted time in the user's timezone
  const formattedSubmittedAt = dayjs(submission.submittedAt).tz(userTimezone).format("h:mm A [on] MMM D (z)");

  const embed = new EmbedBuilder({
    title: submission.house.toUpperCase(),
    color: SUBMISSION_COLORS[submission.status],
    fields: [
      {
        name: "Submission ID",
        value: `${submission.houseId}`,
        inline: false,
      },
      {
        name: "Player",
        value: userMention(submission.discordId),
        inline: true,
      },
      {
        name: "Score",
        value: `${submission.points}`,
        inline: true,
      },
      {
        name: "Submitted by",
        value: `${userMention(submission.discordId)} at ${formattedSubmittedAt}`,
        inline: false,
      },
    ],
    image: {
      url: submission.screenshotUrl,
    },
  });

  const linkedSubmissionUrl =
    linkedSubmission?.channelId && linkedSubmission.messageId
      ? messageLink(linkedSubmission.channelId, linkedSubmission.messageId, process.env.GUILD_ID)
      : null;
  if (linkedSubmissionUrl) {
    embed.addFields({
      name: "Linked Submission",
      value: `[View linked submission](${linkedSubmissionUrl})`,
      inline: false,
    });
  }

  if (submission.status === "APPROVED") {
    embed.addFields({
      name: "Approved by",
      value: `${userMention(submission.reviewedBy ?? "")} at ${time(submission.reviewedAt ?? new Date())}`,
      inline: false,
    });
  } else if (submission.status === "REJECTED") {
    assert(reason, "Rejection reason must be provided for rejected submissions");
    embed.addFields({
      name: "Rejected by",
      value: `${userMention(submission.reviewedBy ?? "")} at ${time(submission.reviewedAt ?? new Date())}`,
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
