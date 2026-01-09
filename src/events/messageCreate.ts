import type { Message, OmitPartialGroupDMChannel } from "discord.js";
import { db, ensureUserExists } from "../db/db.ts";
import { userTable } from "../db/schema.ts";
import { eq, sql } from "drizzle-orm";
import { MIN_DAILY_MESSAGES_FOR_STREAK } from "../utils/constants.ts";
import assert from "node:assert";
import { updateMessageStreakInNickname } from "../utils/streakUtils.ts";
import { createLogger, OpId } from "../utils/logger.ts";

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
  const ctx = { opId, userId: discordId, user: message.author.tag, guild: message.guild.name };

  log.debug("Received", ctx);
  await ensureUserExists(message.member, discordId, message.author.username);

  // Receive counter from the db
  await db.transaction(async (db) => {
    const user = await db
      .select({
        dailyMessages: userTable.dailyMessages,
        messageStreak: userTable.messageStreak,
        ismessageStreakUpdatedToday: userTable.isMessageStreakUpdatedToday,
      })
      .from(userTable)
      .where(eq(userTable.discordId, discordId))
      .then((rows) => rows[0]);
    assert(user !== undefined, "User should exist in DB by this point");

    const newDailyMessages = user.dailyMessages + 1;
    let newStreak = user.messageStreak;
    if (newDailyMessages >= MIN_DAILY_MESSAGES_FOR_STREAK && !user.ismessageStreakUpdatedToday) {
      newStreak = await db
        .update(userTable)
        .set({
          dailyMessages: newDailyMessages,
          messageStreak: sql`${userTable.messageStreak} + 1`,
          isMessageStreakUpdatedToday: true,
        })
        .where(eq(userTable.discordId, discordId))
        .returning({ messageStreak: userTable.messageStreak })
        .then(([row]) => row?.messageStreak ?? user.messageStreak + 1);

      log.info("Streak updated", { ...ctx, newStreak, dailyMessages: newDailyMessages });
    } else {
      await db.update(userTable).set({ dailyMessages: newDailyMessages }).where(eq(userTable.discordId, discordId));
    }

    if (newDailyMessages >= MIN_DAILY_MESSAGES_FOR_STREAK) {
      await updateMessageStreakInNickname(message.member, newStreak, opId);
    }
  });
}
