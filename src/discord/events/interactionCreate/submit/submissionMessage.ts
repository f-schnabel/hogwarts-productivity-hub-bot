import {
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
  messageLink,
  time,
  userMention,
  type InteractionReplyOptions,
} from "discord.js";
import dayjs from "dayjs";
import assert from "node:assert";
import { getUserTimezone } from "@/db/db.ts";
import { submissionTable } from "@/db/schema.ts";
import { SUBMISSION_COLORS, SUBMISSION_TYPES } from "@/common/constants.ts";
import type { SubmissionType } from "@/common/types.ts";

interface SubmissionMessageParams {
  submission: typeof submissionTable.$inferSelect;
  userTimezone?: string;
  reason?: string;
  linkedSubmission?: { channelId: string | null; messageId: string | null };
}

export async function submissionMessage({
  submission,
  userTimezone,
  reason,
  linkedSubmission,
}: SubmissionMessageParams) {
  let components: InteractionReplyOptions["components"] = [];
  if (submission.status === "PENDING") {
    components = [{
      type: ComponentType.ActionRow,
      components: [{
        type: ComponentType.Button,
        customId: `submit|approve|${submission.id}`,
        label: `Approve ${submission.points} points`,
        style: ButtonStyle.Success,
      }, {
        type: ComponentType.Button,
        customId: `submit|reject|${submission.id}`,
        label: "Reject",
        style: ButtonStyle.Secondary,
      }, {
        type: ComponentType.Button,
        customId: `submit|cancel|${submission.id}`,
        label: "Cancel",
        style: ButtonStyle.Secondary,
      }],
    }];
  }

  userTimezone ??= await getUserTimezone(submission.discordId);
  const formattedSubmittedAt = dayjs(submission.submittedAt).tz(userTimezone).format("h:mm A [on] MMM D (z)");

  const embed = new EmbedBuilder({
    title: submission.house.toUpperCase(),
    color: SUBMISSION_COLORS[submission.status],
    fields: [{
      name: "Submission ID",
      value: `${submission.houseId}`,
      inline: false,
    }, {
      name: "List Type",
      value: getSubmissionTypeLabel(submission.submissionType),
      inline: true,
    }, {
      name: "Score",
      value: `${submission.points}`,
      inline: true,
    }, {
      name: "Submitted by",
      value: `${userMention(submission.discordId)} at ${formattedSubmittedAt}`,
      inline: false,
    }],
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
      value: "This submission was cancelled by the user.",
      inline: false,
    });
  }

  return {
    embeds: [embed],
    components,
  };
}

export function getSubmissionTypeLabel(submissionType: SubmissionType | null | undefined): string {
  if (submissionType === SUBMISSION_TYPES.NEW)       return "New List";
  if (submissionType === SUBMISSION_TYPES.COMPLETED) return "Completed List";
  return "Unknown";
}
