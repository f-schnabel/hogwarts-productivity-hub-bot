import type { GuildMember } from "discord.js";
import dayjs from "dayjs";
import { eq } from "drizzle-orm";
import { db } from "@/db/db.ts";
import { userTable } from "@/db/schema.ts";
import { wrapWithAlerting } from "@/discord/utils/alerting.ts";
import { updateMessageStreakInNickname } from "@/discord/core/nicknameStreak.ts";
import { MIN_DAILY_MESSAGES_FOR_STREAK } from "@/common/constants.ts";
import { createLogger } from "@/common/logging/logger.ts";

const log = createLogger("Member");

// When a member rejoins, their stored stats may be stale (a daily/monthly
// boundary could have passed while they were gone). Without this, the next
// hourly reset tick would settle their streak/points at an arbitrary hour
// instead of their real local midnight. We compare the moment they left against
// now (in their timezone) and only reset the windows that actually rolled over.
export async function execute(member: GuildMember) {
  if (member.user.bot) return;

  await wrapWithAlerting(async () => {
    const [user] = await db
      .select({
        timezone: userTable.timezone,
        leftAt: userTable.leftAt,
        lastDailyReset: userTable.lastDailyReset,
        dailyMessages: userTable.dailyMessages,
        messageStreak: userTable.messageStreak,
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
    const daysMissed = now.startOf("day").diff(reference.startOf("day"), "day");

    const updates: Partial<typeof userTable.$inferInsert> = { leftAt: null };
    let newStreak = user.messageStreak;

    // Different local day → daily window is stale: start a fresh day and settle
    // the streak the same way the daily-reset cron would have.
    if (daysMissed >= 1) {
      const metThreshold = user.dailyMessages >= MIN_DAILY_MESSAGES_FOR_STREAK;
      const isBooster = member.premiumSince !== null;

      if (isBooster) {
        // Boosters keep their streak on below-threshold days; their last active
        // day still increments it when they met the threshold.
        newStreak = metThreshold ? user.messageStreak + 1 : user.messageStreak;
      } else if (daysMissed === 1 && metThreshold) {
        // Left having met the threshold and back the very next day → it counts.
        newStreak = user.messageStreak + 1;
      } else {
        // A fully-absent day (0 messages) breaks the streak.
        newStreak = 0;
      }

      updates.lastDailyReset = new Date();
      updates.dailyPoints = 0;
      updates.dailyVoiceTime = 0;
      updates.dailyMessages = 0;
      updates.messageStreak = newStreak;
    }

    // Different month → monthly window is stale: mirror what a monthly reset
    // would have done to them had they been present.
    if (!now.isSame(reference, "month")) {
      updates.monthlyPoints = 0;
      updates.monthlyVoiceTime = 0;
      updates.announcedYear = 0;
    }

    await db.update(userTable).set(updates).where(eq(userTable.discordId, member.id));

    if (newStreak !== user.messageStreak) {
      await updateMessageStreakInNickname(member, newStreak);
    }

    log.info("Member rejoined", {
      userId: member.id,
      user: member.user.username,
      daysMissed,
      streak: newStreak,
      resetMonthly: updates.monthlyPoints !== undefined,
    });
  }, `Guild member add for ${member.user.username} (${member.id})`);
}
