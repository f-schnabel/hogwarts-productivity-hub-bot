import type { Message, OmitPartialGroupDMChannel } from "discord.js";
import { db, ensureUserExists, getCountingState, setCountingState } from "@/db/db.ts";
import { userTable } from "@/db/schema.ts";
import { eq, sql } from "drizzle-orm";
import { createLogger } from "@/common/logging/logger.ts";
import assert from "node:assert/strict";
import { updateMessageStreakInNickname } from "./nickname.ts";

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
  ) return;

  const discordId = message.author.id;

  log.debug("Received", { discordId, user: message.author.tag, message: message.content.slice(0, 100), channelId: message.channelId });
  await ensureUserExists(message.member, discordId, message.author.username);

  await Promise.all([
    streak(message),
    counting(message),
  ]);
}

async function streak(message: OmitPartialGroupDMChannel<Message>) {
  const [row] = await db
    .update(userTable)
    .set({ dailyMessages: sql`${userTable.dailyMessages} + 1` })
    .where(eq(userTable.discordId, message.author.id))
    .returning({ messageStreak: userTable.messageStreak });

  assert(row, "Failed to update daily messages");
  await updateMessageStreakInNickname(message.member, row.messageStreak);
}

async function counting(message: Message) {
  if (process.env.COUNTING_CHANNEL_ID !== message.channelId) return;

  const content = message.content.trim();
  const count = parseInt(content);

  if (content !== String(count)) return;

  const result = await db.transaction(async (tx) => {
    const state = await getCountingState(tx);
    if (message.author.id !== state.discordId && count === state.count + 1) {
      await setCountingState({ count, discordId: message.author.id }, tx);
      return true;
    }
    return false;
  });
  if (result) {
    await message.react("✅");
  }
}
