import type { GuildMember, PartialGuildMember } from "discord.js";
import { eq } from "drizzle-orm";
import { db } from "@/db/db.ts";
import { userTable } from "@/db/schema.ts";
import { wrapWithAlerting } from "@/discord/utils/alerting.ts";
import { createLogger } from "@/common/logging/logger.ts";

const log = createLogger("Member");

// Record when a member leaves so that, on a later rejoin, we can tell which of
// their stats (daily/monthly/streak) have gone stale while they were away.
export async function execute(member: GuildMember | PartialGuildMember) {
  if (member.user.bot) return;

  await wrapWithAlerting(async () => {
    await db.update(userTable).set({ leftAt: new Date() }).where(eq(userTable.discordId, member.id));
  }, `Guild member remove for ${member.user.username} (${member.id})`);

  log.info("Member left", { userId: member.id, user: member.user.username });
}
