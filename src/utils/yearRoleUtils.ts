import { roleMention, type Guild, type GuildMember } from "discord.js";
import { db } from "../db/db.ts";
import { userTable } from "../db/schema.ts";
import { createLogger, type Ctx } from "./logger.ts";
import assert from "node:assert";
import type { House } from "../types.ts";
import { HOUSE_COLORS, YEAR_MESSAGES, YEAR_THRESHOLDS_HOURS, type YEAR } from "./constants.ts";
import { isNotNull } from "drizzle-orm";

const log = createLogger("YearRole");

const YEAR_ROLE_IDS = process.env.YEAR_ROLE_IDS.split(",");
const YEAR_ANNOUNCEMENT_CHANNEL_ID = process.env.YEAR_ANNOUNCEMENT_CHANNEL_ID;

// Returns 1-7 for year, or null if <1 hour
export function getYearFromMonthlyVoiceTime(seconds: number): YEAR | null {
  const hours = seconds / 3600;
  for (const year of [7, 6, 5, 4, 3, 2, 1] as const) {
    const threshold = YEAR_THRESHOLDS_HOURS[year - 1];
    if (threshold !== undefined && hours >= threshold) return year;
  }
  return null;
}

async function announceYearPromotion(member: GuildMember, house: House, year: YEAR, ctx: Ctx): Promise<void> {
  if (!YEAR_ANNOUNCEMENT_CHANNEL_ID) return;

  const roleId = YEAR_ROLE_IDS[year - 1];
  assert(roleId, `No role ID configured for year ${year}`);

  const hours = YEAR_THRESHOLDS_HOURS[year - 1];
  assert(hours, `No hours threshold configured for year ${year}`);

  const message = YEAR_MESSAGES[house]
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
            color: HOUSE_COLORS[house],
          },
        ],
      });
    } else {
      log.error("Year announcement channel is not text-based", ctx);
    }
  } catch (error) {
    log.error("Failed to send year promotion announcement:", { error, ...ctx });
  }
}

export async function updateYearRole(
  member: GuildMember,
  monthlyVoiceTimeSeconds: number,
  house: House,
  opId: string,
): Promise<void> {
  if (YEAR_ROLE_IDS.length !== 7) return; // Skip if not configured

  const year = getYearFromMonthlyVoiceTime(monthlyVoiceTimeSeconds);
  const roleId = year === null ? null : YEAR_ROLE_IDS[year - 1];
  const ctx = { opId, userId: member.id, user: member.user.displayName };

  // Remove all year roles except target
  const rolesToRemove = YEAR_ROLE_IDS.filter((id) => id !== roleId && member.roles.cache.has(id));
  if (rolesToRemove.length > 0) {
    log.debug("Removing year roles", { ...ctx, roles: rolesToRemove.join(",") });
    await member.roles.remove(rolesToRemove);
  }

  // Add role if needed
  if (roleId && !member.roles.cache.has(roleId)) {
    assert(year !== null, "Year should be defined if role ID exists");
    log.info("Adding year role", { ...ctx, roleId: roleId, year });
    await member.roles.add(roleId);
    await announceYearPromotion(member, house, year, ctx);
  }
}

export async function refreshAllYearRoles(guild: Guild, opId: string): Promise<number> {
  if (YEAR_ROLE_IDS.length !== 7) return 0;

  const users = await db
    .select({ discordId: userTable.discordId, monthlyVoiceTime: userTable.monthlyVoiceTime, house: userTable.house })
    .from(userTable)
    .where(isNotNull(userTable.house));
  let updated = 0;

  for (const user of users) {
    assert(user.house, "User house should be defined");
    try {
      const member = guild.members.cache.get(user.discordId);
      if (!member) continue;
      await updateYearRole(member, user.monthlyVoiceTime, user.house, opId);
      updated++;
    } catch {
      // Member not in guild, skip
    }
  }

  return updated;
}
