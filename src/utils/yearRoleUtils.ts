import { roleMention, userMention, type Guild, type GuildMember, type TextChannel } from "discord.js";
import { db } from "../db/db.ts";
import { userTable } from "../db/schema.ts";
import { createLogger, type Ctx } from "./logger.ts";
import assert from "node:assert";
import { client } from "../client.ts";
import type { House } from "../types.ts";
import { HOUSE_COLORS } from "./constants.ts";
import { isNotNull } from "drizzle-orm";

const log = createLogger("YearRole");

// Thresholds in hours, index = year - 1
type YEAR = 1 | 2 | 3 | 4 | 5 | 6 | 7;
const YEAR_THRESHOLDS_HOURS = [1, 10, 20, 40, 80, 100, 120] as const;
const YEAR_ROLE_IDS = process.env["YEAR_ROLE_IDS"]?.split(",") ?? [];
const YEAR_ANNOUNCEMENT_CHANNEL_ID = process.env["YEAR_ANNOUNCEMENT_CHANNEL_ID"];
let CACHED_YEAR_CHANNEL: null | TextChannel = null;

const YEAR_MESSAGES: Record<House, string> = {
  Gryffindor: "🦁 True courage lies in perseverance. You rise to {ROLE} with **{HOURS}** of steadfast effort.",
  Slytherin: "🐍 Ambition well applied brings results. {ROLE} claimed after **{HOURS}** of focused study.",
  Hufflepuff: "🌟 Your consistency shines brightest. {ROLE} earned through **{HOURS}** in the study halls.",
  Ravenclaw: "✒️ Each hour sharpened your mind — {ROLE} is now yours after **{HOURS}**. Wisdom suits you.",
};

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
    const channel = CACHED_YEAR_CHANNEL ?? ((await client.channels.fetch(YEAR_ANNOUNCEMENT_CHANNEL_ID)) as TextChannel);
    if (channel.isTextBased()) {
      await channel.send({
        embeds: [
          {
            title: "New Activity Rank Attained!",
            description: `Congratulations ${userMention(member.id)}!\n\n${message}`,
            color: HOUSE_COLORS[house],
          },
        ],
      });
      CACHED_YEAR_CHANNEL = channel;
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

  const targetYear = getYearFromMonthlyVoiceTime(monthlyVoiceTimeSeconds);
  const targetRoleId = targetYear === null ? null : YEAR_ROLE_IDS[targetYear - 1];
  const ctx = { opId, userId: member.id, user: member.user.displayName };

  // Remove all year roles except target
  const rolesToRemove = YEAR_ROLE_IDS.filter((id) => id !== targetRoleId && member.roles.cache.has(id));
  if (rolesToRemove.length > 0) {
    log.debug("Removing year roles", { ...ctx, roles: rolesToRemove.join(",") });
    await member.roles.remove(rolesToRemove);
  }

  // Add target role if needed
  if (targetRoleId && !member.roles.cache.has(targetRoleId)) {
    assert(targetYear !== null, "Target year should be defined if target role ID exists");
    log.info("Adding year role", { ...ctx, roleId: targetRoleId, year: targetYear });
    await member.roles.add(targetRoleId);
    await announceYearPromotion(member, house, targetYear, ctx);
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
    try {
      assert(user.house, "User house should be defined");
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
