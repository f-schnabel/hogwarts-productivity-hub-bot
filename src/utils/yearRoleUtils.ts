import { roleMention, userMention, type Guild, type GuildMember, type TextChannel } from "discord.js";
import { db } from "../db/db.ts";
import { userTable } from "../db/schema.ts";
import { createLogger } from "./logger.ts";
import assert from "assert";
import { client } from "../client.ts";
import type { House } from "../types.ts";
import { getHouseFromMember } from "./utils.ts";
import { HOUSE_COLORS } from "./constants.ts";

const log = createLogger("YearRole");

// Thresholds in hours, index = year - 1
type YEAR = 1 | 2 | 3 | 4 | 5 | 6 | 7;
const YEAR_THRESHOLDS_HOURS = [1, 10, 20, 40, 80, 100, 120] as const;
const YEAR_ROLE_IDS = process.env["YEAR_ROLE_IDS"]?.split(",") ?? [];
const YEAR_ANNOUNCEMENT_CHANNEL_ID = process.env["YEAR_ANNOUNCEMENT_CHANNEL_ID"];

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

async function announceYearPromotion(member: GuildMember, year: YEAR): Promise<void> {
  if (!YEAR_ANNOUNCEMENT_CHANNEL_ID) return;

  const house = getHouseFromMember(member);
  if (!house) return;
  const roleId = YEAR_ROLE_IDS[year - 1];
  assert(roleId, `No role ID configured for year ${year}`);
  const hours = YEAR_THRESHOLDS_HOURS[year - 1];
  assert(hours, `No hours threshold configured for year ${year}`);

  const message = YEAR_MESSAGES[house].replace("{ROLE}", roleMention(roleId)).replace("{HOURS}", hours.toString() + (hours === 1 ? " hour" : " hours"));
  try {
    const channel = await client.channels.fetch(YEAR_ANNOUNCEMENT_CHANNEL_ID);
    if (channel?.isTextBased()) {
      await (channel as TextChannel).send({
        embeds: [
          {
            title: "New Activity Rank Attained!",
            description: `Congratulations ${userMention(member.id)}!\n${message}`,
            color: HOUSE_COLORS[house],
          },
        ],
      });
    }
  } catch (error) {
    console.error("Failed to send year promotion announcement:", error);
  }
}

export async function updateYearRole(
  member: GuildMember,
  monthlyVoiceTimeSeconds: number,
  opId: string,
): Promise<void> {
  if (YEAR_ROLE_IDS.length !== 7) return; // Skip if not configured

  const targetYear = getYearFromMonthlyVoiceTime(monthlyVoiceTimeSeconds);
  const targetRoleId = targetYear !== null ? YEAR_ROLE_IDS[targetYear - 1] : null;
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
    await announceYearPromotion(member, targetYear);
  }
}

export async function refreshAllYearRoles(guild: Guild, opId: string): Promise<number> {
  if (YEAR_ROLE_IDS.length !== 7) return 0;

  const users = await db
    .select({ discordId: userTable.discordId, monthlyVoiceTime: userTable.monthlyVoiceTime })
    .from(userTable);
  let updated = 0;

  for (const user of users) {
    try {
      const member = await guild.members.fetch(user.discordId);
      await updateYearRole(member, user.monthlyVoiceTime, opId);
      updated++;
    } catch {
      // Member not in guild, skip
    }
  }

  return updated;
}
