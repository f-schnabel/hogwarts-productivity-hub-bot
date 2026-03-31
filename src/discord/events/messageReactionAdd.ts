import type { MessageReaction, PartialMessageReaction, PartialUser, User } from "discord.js";
import { and, eq, or } from "drizzle-orm";
import assert from "node:assert/strict";
import { db } from "@/db/db.ts";
import { submissionTable } from "@/db/schema.ts";
import { Role } from "@/common/constants.ts";
import { createLogger } from "@/common/logger.ts";
import { hasAnyRole } from "@/discord/utils/roleUtils.ts";
import { reverseSubmissionPoints } from "@/services/pointsService.ts";
import { submissionMessage } from "@/discord/commands/submit.ts";

const log = createLogger("Reaction");

export async function execute(
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
): Promise<void> {
  if (reaction.partial || user.partial || user.bot || reaction.emoji.name !== "⬅️" || !reaction.message.guild) return;

  const member = reaction.message.guild.members.cache.get(user.id);
  if (!member || !hasAnyRole(member, Role.PREFECT)) return;

  const ctx = {
    userId: user.id,
    emoji: reaction.emoji.name,
    messageId: reaction.message.id,
    channelId: reaction.message.channelId,
  };

  const submission = await db.query.submissionTable.findFirst({
    where: eq(submissionTable.messageId, reaction.message.id),
  });

  if (submission?.status !== "APPROVED" && submission?.status !== "REJECTED") return;

  const reopenedSubmission = await db.transaction(async (tx) => {
    const [updatedSubmission] = await tx
      .update(submissionTable)
      .set({ status: "PENDING", reviewedAt: null, reviewedBy: null })
      .where(and(eq(submissionTable.id, submission.id), eq(submissionTable.status, submission.status)))
      .returning();

    if (!updatedSubmission) return null;

    if (submission.status === "APPROVED") {
      assert(submission.reviewedAt, "Approved submissions must have a review timestamp");
      await reverseSubmissionPoints(tx, submission.discordId, submission.points, submission.reviewedAt);
    }

    return updatedSubmission;
  });

  if (!reopenedSubmission) return;

  const linkedSubmission = await db.query.submissionTable.findFirst({
    columns: { channelId: true, messageId: true },
    where: or(
      reopenedSubmission.linkedSubmissionId ? eq(submissionTable.id, reopenedSubmission.linkedSubmissionId) : undefined,
      eq(submissionTable.linkedSubmissionId, reopenedSubmission.id),
    ),
  });

  await reaction.message.edit(await submissionMessage({ submission: reopenedSubmission, linkedSubmission }));
  log.info("Reopened submission from reaction", { ...ctx, submissionId: reopenedSubmission.id });
}
