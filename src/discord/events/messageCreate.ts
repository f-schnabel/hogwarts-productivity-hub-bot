import type { Message, OmitPartialGroupDMChannel } from "discord.js";
import { db, ensureUserExists } from "../../db/db.ts";
import { userTable } from "../../db/schema.ts";
import { eq, sql } from "drizzle-orm";
import { createLogger, OpId } from "../../common/logger.ts";
import assert from "node:assert/strict";
import { updateMessageStreakInNickname } from "../utils/nicknameUtils.ts";

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

  const row = await db
    .update(userTable)
    .set({
      dailyMessages: sql`${userTable.dailyMessages} + 1`,
    })
    .where(eq(userTable.discordId, discordId))
    .returning({ messageStreak: userTable.messageStreak })
    .then((res) => res[0]);

  assert(row, "Failed to update daily messages");
  await updateMessageStreakInNickname(message.member, row.messageStreak, opId);
}
