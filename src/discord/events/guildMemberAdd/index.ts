import type { GuildMember } from "discord.js";
import dayjs from "dayjs";
import { eq } from "drizzle-orm";
import { db, getMonthStartDate } from "@/db/db.ts";
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
    // the streak. The last active day still counts (+1) if it met the threshold
    // and they return the very next day; otherwise the chain is broken (a
    // fully-absent day, or a last day below threshold). No booster handling is
    // needed: leaving the guild ends the boost, so a member is never boosting at
    // the moment they rejoin.
    if (daysMissed >= 1) {
      const metThreshold = user.dailyMessages >= MIN_DAILY_MESSAGES_FOR_STREAK;
      newStreak = daysMissed === 1 && metThreshold ? user.messageStreak + 1 : 0;

      updates.lastDailyReset = new Date();
      updates.dailyPoints = 0;
      updates.dailyVoiceTime = 0;
      updates.dailyMessages = 0;
      updates.messageStreak = newStreak;
    }

    // Monthly resets are a manual admin action recorded as a timestamp, not a
    // calendar boundary. So compare the actual instants: if they left before the
    // most recent monthly reset, that reset happened while they were away and
    // their monthly stats are stale. (Instant comparison, so timezone / the
    // window right before 00:00 UTC doesn't matter.)
    const lastMonthlyReset = await getMonthStartDate();
    if (reference.isBefore(lastMonthlyReset)) {
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
