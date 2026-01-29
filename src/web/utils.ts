import type { House } from "@/common/types.ts";
import { HOUSE_COLORS } from "@/common/constants.ts";
import { client } from "@/discord/client.ts";

// Analytics-specific color overrides for dark background readability
const ANALYTICS_HOUSE_COLORS: Partial<Record<House, number>> = {
  Ravenclaw: 0x5b7fc7,
};

export function getHouseColor(house: House | null): string {
  if (!house) return "#888";
  const color = ANALYTICS_HOUSE_COLORS[house] ?? HOUSE_COLORS[house];
  return `#${color.toString(16).padStart(6, "0")}`;
}

export function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function cleanDisplayName(name: string, vcEmoji: string): string {
  return name
    .replace(/⚡\d+/g, "") // Remove streak
    .replace(new RegExp(` ${vcEmoji}`, "g"), "") // Remove VC emoji
    .trim();
}

interface MemberInfo {
  displayName: string;
  isProfessor: boolean;
}

export async function fetchMemberInfo(discordIds: string[]): Promise<Map<string, MemberInfo>> {
  const guild = client.guilds.cache.get(process.env.GUILD_ID);
  if (!guild) return new Map();
  const members = await guild.members.fetch({ user: discordIds });
  const info = new Map<string, MemberInfo>();
  const professorRoleId = process.env.PROFESSOR_ROLE_ID;
  members.forEach((member, id) =>
    info.set(id, {
      displayName: member.displayName,
      isProfessor: professorRoleId ? member.roles.cache.has(professorRoleId) : false,
    }),
  );
  return info;
}
