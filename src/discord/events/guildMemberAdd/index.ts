import type { GuildMember } from "discord.js";
import dayjs from "dayjs";
import { eq } from "drizzle-orm";
import { db } from "@/db/db.ts";
import { userTable } from "@/db/schema.ts";
import { wrapWithAlerting } from "@/discord/utils/alerting.ts";
import { createLogger } from "@/common/logging/logger.ts";

const log = createLogger("Member");

// When a member rejoins, their stored stats may be stale (a daily/monthly
// boundary could have passed while they were gone). Without this, the next
// hourly reset tick would wipe their streak/points at an arbitrary hour instead
// of their real local midnight. We compare the moment they left against now (in
// their timezone) and only reset the windows that actually rolled over.
export async function execute(member: GuildMember) {
  if (member.user.bot) return;

  await wrapWithAlerting(async () => {
    const [user] = await db
      .select({
        timezone: userTable.timezone,
        leftAt: userTable.leftAt,
        lastDailyReset: userTable.lastDailyReset,
      })
      .from(userTable)
      .where(eq(userTable.discordId, member.id));

    // Brand-new member: no row yet. It is created with now() on first activity,
    // which already starts a correct daily/monthly window.
    if (!user) return;

    // Reference = when they left. Fall back to last reset for rows that predate
    // leave-tracking (e.g. members who left before this feature existed).
    const reference = dayjs(user.leftAt ?? user.lastDailyReset).tz(user.timezone);
    const now = dayjs().tz(user.timezone);

    const updates: Partial<typeof userTable.$inferInsert> = { leftAt: null };

    // Different local day → daily window is stale: start a fresh day now and
    // reset the message streak.
    if (!now.isSame(reference, "day")) {
      updates.lastDailyReset = new Date();
      updates.dailyPoints = 0;
      updates.dailyVoiceTime = 0;
      updates.dailyMessages = 0;
      updates.messageStreak = 0;
    }

    // Different month → monthly window is stale: mirror what a monthly reset
    // would have done to them had they been present.
    if (!now.isSame(reference, "month")) {
      updates.monthlyPoints = 0;
      updates.monthlyVoiceTime = 0;
      updates.announcedYear = 0;
    }

    await db.update(userTable).set(updates).where(eq(userTable.discordId, member.id));

    log.info("Member rejoined", {
      userId: member.id,
      user: member.user.username,
      resetDaily: updates.lastDailyReset !== undefined,
      resetMonthly: updates.monthlyPoints !== undefined,
    });
  }, `Guild member add for ${member.user.username} (${member.id})`);
}
