import {
  bold,
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
import { hasAnyRole } from "@/discord/utils/roleUtils.ts";
import { errorReply, inGuild } from "@/discord/utils/interactionUtils.ts";
import assert from "node:assert";
import { db, getHouseFromMember, getMonthStartDate, getUserTimezone } from "@/db/db.ts";
import { submissionTable } from "@/db/schema.ts";
import { and, eq, gte, inArray, isNotNull, lt, or, sql } from "drizzle-orm";
import { DEFAULT_SUBMISSION_POINTS, Role, SUBMISSION_COLORS } from "@/common/constants.ts";
import type { CommandOptions } from "@/common/types.ts";
import { alertOwner } from "../utils/alerting.ts";

const SUBMISSION_CHANNEL_IDS = process.env.SUBMISSION_CHANNEL_IDS.split(",");
const SUBMISSION_TYPES = {
  NEW: "NEW",
  COMPLETED: "COMPLETED",
} as const;

type SubmissionType = (typeof SUBMISSION_TYPES)[keyof typeof SUBMISSION_TYPES];

export default {
  data: new SlashCommandBuilder()
    .setName("submit")
    .setDescription("Submit a score")
    .addStringOption((option) =>
      option
        .setName("type")
        .setDescription("Choose whether this is your new or completed list")
        .setRequired(true)
        .addChoices(
          { name: "New List", value: SUBMISSION_TYPES.NEW },
          { name: "Completed List", value: SUBMISSION_TYPES.COMPLETED },
        ),
    )
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
    const submissionType = interaction.options.getString("type", true) as SubmissionType;

    const house = getHouseFromMember(interaction.member);
    assert(house, "User does not have a house role assigned");

    // Fetch user's timezone for validation and display
    const userTimezone = await getUserTimezone(interaction.member.id);
    const dayStart = dayjs().tz(userTimezone).startOf("day");
    const dayEnd = dayStart.add(1, "day");
    const sameDaySubmissions = await db.query.submissionTable.findMany({
      where: and(
        eq(submissionTable.discordId, interaction.member.id),
        gte(submissionTable.submittedAt, dayStart.toDate()),
        lt(submissionTable.submittedAt, dayEnd.toDate()),
        inArray(submissionTable.status, ["PENDING", "APPROVED"]),
        isNotNull(submissionTable.submissionType),
      ),
    });

    const newSubmission = sameDaySubmissions.find((s) => s.submissionType === SUBMISSION_TYPES.NEW);
    const completedSubmission = sameDaySubmissions.find((s) => s.submissionType === SUBMISSION_TYPES.COMPLETED);

    const firstSubmission = sameDaySubmissions[0];
    if (submissionType === SUBMISSION_TYPES.NEW && firstSubmission?.submissionType) {
      const blockingSubmissionUrl =
        firstSubmission.channelId && firstSubmission.messageId
          ? messageLink(firstSubmission.channelId, firstSubmission.messageId, process.env.GUILD_ID)
          : null;

      await errorReply(
        opId,
        interaction,
        "New List Already Submitted Today",
        `You already have a ${bold(getSubmissionTypeLabel(firstSubmission.submissionType))} with status ${bold(firstSubmission.status.toLowerCase())} today, so you cannot submit another one.${blockingSubmissionUrl ? ` You can view the blocking submission [here](${blockingSubmissionUrl}).` : ""} If the blocking submission is still pending and incorrect, you can cancel it from the submission message.`,
      );
      return;
    }

    if (submissionType === SUBMISSION_TYPES.COMPLETED && completedSubmission) {
      const blockingSubmissionUrl =
        completedSubmission.channelId && completedSubmission.messageId
          ? messageLink(completedSubmission.channelId, completedSubmission.messageId, process.env.GUILD_ID)
          : null;

      await errorReply(
        opId,
        interaction,
        "Completed List Already Submitted Today",
        `You already have a ${bold("Completed List")} with status ${bold(completedSubmission.status.toLowerCase())} today, so you cannot submit another one.${blockingSubmissionUrl ? ` You can view the blocking submission [here](${blockingSubmissionUrl}).` : ""} If the blocking submission is still pending and incorrect, you can cancel it from the submission message.`,
      );
      return;
    }

    if (submissionType === SUBMISSION_TYPES.COMPLETED && newSubmission) {
      const retryTime = dayjs(newSubmission.submittedAt).add(1, "hour");
      const tooLate = retryTime.isAfter(dayEnd) || retryTime.isSame(dayEnd);

      if (dayjs().isBefore(retryTime)) {
        const waitMessage = tooLate
          ? "It is too late to submit again today."
          : `Otherwise please wait until ${time(retryTime.toDate())} before submitting again.`;

        await errorReply(
          opId,
          interaction,
          "Please wait before submitting again",
          `${bold("There has to be at least an hour between submitting the new and the completed To-Do List")}. You already have submitted in the past hour.\n
        If the previous submission was wrong you can cancel it by clicking on the button above.
        ${waitMessage}`,
        );
        return;
      }
    }

    const linkedSubmission = submissionType === SUBMISSION_TYPES.COMPLETED ? newSubmission : undefined;
    const monthStartDate = await getMonthStartDate();
    const [submission] = await db
      .insert(submissionTable)
      .values({
        discordId: interaction.member.id,
        points: DEFAULT_SUBMISSION_POINTS,
        screenshotUrl: screenshot.url,
        house: house,
        submissionType,
        linkedSubmissionId: linkedSubmission?.id ?? null,
        // Calculate next house submission ID by counting existing submissions
        houseId: sql`(
          SELECT COUNT(*) + 1
          FROM ${submissionTable}
          WHERE ${submissionTable.house} = ${house}
            AND ${submissionTable.submittedAt} >= ${monthStartDate}
        )`,
      })
      .returning();
    assert(submission, "Failed to create submission");

    // Send the reply and capture message ID for future cross-referencing
    const response = await interaction.reply({
      ...(await submissionMessage({ submission, userTimezone, linkedSubmission })),
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
            await submissionMessage({
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
    assert(submissionId, "No data provided in button interaction");

    if (event === "cancel") {
      await cancelSubmission(Number.parseInt(submissionId), interaction);
      return;
    }

    if (!hasAnyRole(member, Role.PREFECT)) {
      await interaction.reply({
        content: "You do not have permission to perform this action.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

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
      .where(and(eq(submissionTable.id, Number.parseInt(submissionId)), eq(submissionTable.status, "PENDING")))
      .returning();

    if (!submission) {
      await interaction.followUp({
        content: "This submission has already been reviewed.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

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
      .then(async (m) => m.edit(await submissionMessage({ submission, reason, linkedSubmission })));

    if (event === "approve") {
      await awardPoints(db, submission.discordId, submission.points, opId);
    } else if (event === "reject") {
      assert(reason, "Rejection reason must be provided");
      const submissionLink = messageLink(interaction.channelId, interaction.message.id, process.env.GUILD_ID);
      await interaction.followUp(
        `${userMention(submission.discordId)} Your [submission](${submissionLink}) was rejected. Reason: ${reason}`,
      );
    }
  },
};

async function cancelSubmission(submissionId: number, interaction: ButtonInteraction) {
  await interaction.deferUpdate();

  const [canceled] = await db
    .update(submissionTable)
    .set({ status: "CANCELED", reviewedAt: new Date(), reviewedBy: interaction.user.id })
    .where(
      and(
        eq(submissionTable.id, submissionId),
        eq(submissionTable.status, "PENDING"),
        eq(submissionTable.discordId, interaction.user.id),
      ),
    )
    .returning();

  if (!canceled) {
    await interaction.followUp({
      content: "This submission has already been reviewed or belongs to another user.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.message.fetch().then(async (m) => m.edit(await submissionMessage({ submission: canceled })));
  return;
}

interface SubmissionMessageParams {
  submission: typeof submissionTable.$inferSelect;
  userTimezone?: string;
  reason?: string;
  linkedSubmission?: { channelId: string | null; messageId: string | null };
}

async function submissionMessage({ submission, userTimezone, reason, linkedSubmission }: SubmissionMessageParams) {
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
          {
            type: ComponentType.Button,
            customId: `submit|cancel|${submission.id}`,
            label: "Cancel",
            style: ButtonStyle.Secondary,
          },
        ],
      },
    ];
  }

  userTimezone ??= await getUserTimezone(submission.discordId);
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
        name: "List Type",
        value: getSubmissionTypeLabel(submission.submissionType),
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
  } else if (submission.status === "CANCELED") {
    embed.addFields({
      name: "Cancelled",
      value: `This submission was cancelled by the user.`,
      inline: false,
    });
  }

  return {
    embeds: [embed],
    components: components,
  };
}

function getSubmissionTypeLabel(submissionType: SubmissionType | null | undefined): string {
  if (submissionType === SUBMISSION_TYPES.NEW) return "New List";
  if (submissionType === SUBMISSION_TYPES.COMPLETED) return "Completed List";
  return "Unknown";
}
