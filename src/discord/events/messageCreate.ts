import type { Message, OmitPartialGroupDMChannel } from "discord.js";
import { db, ensureUserExists } from "../../db/db.ts";
import { userTable } from "../../db/schema.ts";
import { eq, sql } from "drizzle-orm";
import { MIN_DAILY_MESSAGES_FOR_STREAK } from "../../common/constants.ts";
import assert from "node:assert";
import { updateMessageStreakInNickname } from "../utils/nicknameUtils.ts";
import { createLogger, OpId } from "../../common/logger.ts";

const log = createLogger("Message");

export async function execute(message: OmitPartialGroupDMChannel<Message>): Promise<void> {
  // Ignore messages from bots, Ignore messages not in a guild and system messages
  if (message.author.bot || !message.inGuild() || message.system) return;
  // Ignore replies to system messages (Wave Hi)
  if (
    message.reference &&
    (await message
      .fetchReference()
      .then((msg) => msg.system)
      // Ignore errors because of forwards from other guilds
      .catch(() => false))
  )
    return;

  const discordId = message.author.id;
  const opId = OpId.msg();
  const ctx = {
    opId,
    discordId,
    user: message.author.tag,
    message: message.content.slice(0, 100),
    channelId: message.channelId,
  };

  log.debug("Received", ctx);
  await ensureUserExists(message.member, discordId, message.author.username);

  // Update message count and conditionally update streak in single query
  const result = await db
    .update(userTable)
    .set({
      dailyMessages: sql`${userTable.dailyMessages} + 1`,
      messageStreak: sql`CASE
        WHEN ${userTable.dailyMessages} + 1 >= ${MIN_DAILY_MESSAGES_FOR_STREAK}
          AND NOT ${userTable.isMessageStreakUpdatedToday}
        THEN ${userTable.messageStreak} + 1
        ELSE ${userTable.messageStreak}
      END`,
      isMessageStreakUpdatedToday: sql`CASE
        WHEN ${userTable.dailyMessages} + 1 >= ${MIN_DAILY_MESSAGES_FOR_STREAK}
        THEN true
        ELSE ${userTable.isMessageStreakUpdatedToday}
      END`,
    })
    .where(eq(userTable.discordId, discordId))
    .returning({
      dailyMessages: userTable.dailyMessages,
      messageStreak: userTable.messageStreak,
      streakJustUpdated: sql<boolean>`${userTable.dailyMessages} = ${MIN_DAILY_MESSAGES_FOR_STREAK}`,
    })
    .then(([row]) => row);
  assert(result !== undefined, "User should exist in DB by this point");

  if (result.streakJustUpdated) {
    log.info("Streak updated", { ...ctx, ...result });
  }

  if (result.dailyMessages >= MIN_DAILY_MESSAGES_FOR_STREAK) {
    await updateMessageStreakInNickname(message.member, result.messageStreak, opId);
  }
}
