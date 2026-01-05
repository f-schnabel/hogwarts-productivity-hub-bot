import type { Guild, GuildMember } from "discord.js";
import { db } from "../db/db.ts";
import { userTable } from "../db/schema.ts";
import { createLogger } from "./logger.ts";

const log = createLogger("YearRole");

// Thresholds in hours, index = year - 1
const YEAR_THRESHOLDS_HOURS = [1, 10, 20, 40, 80, 100, 120] as const;
const YEAR_ROLE_IDS = process.env["YEAR_ROLE_IDS"]?.split(",") ?? [];

// Returns 1-7 for year, or null if <1 hour
export function getYearFromMonthlyVoiceTime(seconds: number): number | null {
  const hours = seconds / 3600;
  for (let year = 7; year >= 1; year--) {
    const threshold = YEAR_THRESHOLDS_HOURS[year - 1];
    if (threshold !== undefined && hours >= threshold) return year;
  }
  return null;
}

export async function updateYearRole(
  member: GuildMember,
  monthlyVoiceTimeSeconds: number,
  opId?: string,
): Promise<void> {
  if (YEAR_ROLE_IDS.length !== 7) return; // Skip if not configured

  const targetYear = getYearFromMonthlyVoiceTime(monthlyVoiceTimeSeconds);
  const targetRoleId = targetYear !== null ? YEAR_ROLE_IDS[targetYear - 1] : null;
  const ctx = { opId: opId ?? "role", userId: member.id, user: member.user.displayName };

  // Remove all year roles except target
  const rolesToRemove = YEAR_ROLE_IDS.filter((id) => id !== targetRoleId && member.roles.cache.has(id));
  if (rolesToRemove.length > 0) {
    log.debug("Removing year roles", { ...ctx, roles: rolesToRemove.join(",") });
    await member.roles.remove(rolesToRemove);
  }

  // Add target role if needed
  if (targetRoleId && !member.roles.cache.has(targetRoleId)) {
    log.info("Adding year role", { ...ctx, roleId: targetRoleId, year: targetYear });
    await member.roles.add(targetRoleId);
  }
}

export async function refreshAllYearRoles(guild: Guild): Promise<number> {
  if (YEAR_ROLE_IDS.length !== 7) return 0;

  const users = await db
    .select({ discordId: userTable.discordId, monthlyVoiceTime: userTable.monthlyVoiceTime })
    .from(userTable);
  let updated = 0;

  for (const user of users) {
    try {
      const member = await guild.members.fetch(user.discordId);
      await updateYearRole(member, user.monthlyVoiceTime);
      updated++;
    } catch {
      // Member not in guild, skip
    }
  }

  return updated;
}
