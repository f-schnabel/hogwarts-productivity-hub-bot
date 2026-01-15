import { roleMention, type Guild, type GuildMember } from "discord.js";
import { db } from "../db/db.ts";
import { userTable } from "../db/schema.ts";
import { createLogger, type Ctx } from "./logger.ts";
import assert from "node:assert";
import type { House } from "../types.ts";
import { HOUSE_COLORS, YEAR_MESSAGES, YEAR_THRESHOLDS_HOURS, type YEAR } from "./constants.ts";
import { eq, isNotNull } from "drizzle-orm";
import { updateMember, type UpdateMemberParams } from "../events/voiceStateUpdate.ts";

const log = createLogger("YearRole");

const YEAR_ROLE_IDS = process.env.YEAR_ROLE_IDS.split(",");
const YEAR_ANNOUNCEMENT_CHANNEL_ID = process.env.YEAR_ANNOUNCEMENT_CHANNEL_ID;

// Returns 1-7 for year, or null if <1 hour
function getYearFromMonthlyVoiceTime(seconds: number): YEAR | null {
  const hours = seconds / 3600;
  for (const year of [7, 6, 5, 4, 3, 2, 1] as const) {
    const threshold = YEAR_THRESHOLDS_HOURS[year - 1];
    if (threshold !== undefined && hours >= threshold) return year;
  }
  return null;
}

export async function announceYearPromotion(
  member: GuildMember,
  user: { monthlyVoiceTime: number; house: House | null; announcedYear: number } | null,
  ctx: Ctx,
): Promise<void> {
  if (!user?.house) return;
  const year = getYearFromMonthlyVoiceTime(user.monthlyVoiceTime);
  if (year === null || user.announcedYear >= year) return; // Already announced this year or higher

  const roleId = YEAR_ROLE_IDS[year - 1];
  assert(roleId, `No role ID configured for year ${year}`);

  const hours = YEAR_THRESHOLDS_HOURS[year - 1];
  assert(hours, `No hours threshold configured for year ${year}`);

  const message = YEAR_MESSAGES[user.house]
    .replace("{ROLE}", roleMention(roleId))
    .replace("{HOURS}", hours.toString() + (hours === 1 ? " hour" : " hours"));
  try {
    const channel = await member.guild.channels.fetch(YEAR_ANNOUNCEMENT_CHANNEL_ID);
    if (channel?.isTextBased()) {
      await channel.send({
        embeds: [
          {
            title: "New Activity Rank Attained!",
            description: `Congratulations ${member.toString()}!\n\n${message}`,
            color: HOUSE_COLORS[user.house],
          },
        ],
      });
      if (year !== user.announcedYear) {
        await db.update(userTable).set({ announcedYear: year }).where(eq(userTable.discordId, member.id));
      }
    } else {
      log.error("Year announcement channel is not text-based", ctx);
    }
  } catch (error) {
    log.error("Failed to send year promotion announcement:", { error, ...ctx });
  }
}

export function calculateYearRoles(
  member: GuildMember,
  user: { monthlyVoiceTime: number; house: House | null } | null,
): { rolesToRemove: string[]; rolesToAdd: string[] } | null {
  if (!user?.house) return null;
  const { monthlyVoiceTime } = user;

  if (YEAR_ROLE_IDS.length !== 7) return null; // Skip if not configured

  const year = getYearFromMonthlyVoiceTime(monthlyVoiceTime);
  const roleId = year === null ? null : YEAR_ROLE_IDS[year - 1];

  // Remove all year roles except target
  const rolesToRemove = YEAR_ROLE_IDS.filter((id) => id !== roleId && member.roles.cache.has(id));
  const rolesToAdd = roleId && !member.roles.cache.has(roleId) ? [roleId] : [];

  return { rolesToRemove, rolesToAdd };
}

export async function refreshAllYearRoles(guild: Guild): Promise<number> {
  if (YEAR_ROLE_IDS.length !== 7) return 0;

  const users = await db
    .select({ discordId: userTable.discordId, monthlyVoiceTime: userTable.monthlyVoiceTime, house: userTable.house })
    .from(userTable)
    .where(isNotNull(userTable.house));
  let updated = 0;

  const updates: UpdateMemberParams[] = [];
  for (const user of users) {
    assert(user.house, "User house should be defined");
    try {
      const member = guild.members.cache.get(user.discordId);
      if (!member) continue;
      updates.push({
        member,
        roleUpdates: calculateYearRoles(member, user),
      });
      updated++;
    } catch {
      // Member not in guild, skip
    }
  }
  await Promise.all(
    updates.map(async ({ member, roleUpdates }) => {
      await updateMember({
        member,
        reason: "Refreshing year roles",
        roleUpdates,
      });
    }),
  );
  return updated;
}
