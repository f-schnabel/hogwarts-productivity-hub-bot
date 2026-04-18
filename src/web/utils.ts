import type { House } from "@/common/types.ts";
import { HOUSE_COLORS, MIN_MONTHLY_POINTS_FOR_WEIGHTED } from "@/common/constants.ts";
import { client } from "@/discord/client.ts";
import dayjs from "dayjs";

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

/**
 * Build cumulative weighted-points series per house per day.
 * Weighted = truncated avg(cumulative monthlyPoints) over users with cumulative > threshold.
 */
export function buildHousePaceChart(
  events: { discordId: string; house: House | null; day: string; points: number }[],
  monthStart: Date,
) {
  const start = dayjs(monthStart).startOf("day");
  const today = dayjs().startOf("day");
  const days = Math.max(1, today.diff(start, "day") + 1);

  const labels: string[] = [];
  const dayKeys: string[] = [];
  for (let i = 0; i < days; i++) {
    const d = start.add(i, "day");
    labels.push(d.format("MMM D"));
    dayKeys.push(d.format("YYYY-MM-DD"));
  }

  // user -> house, user -> day -> daily delta
  const userHouse = new Map<string, House | null>();
  const userDayDelta = new Map<string, Map<string, number>>();
  for (const e of events) {
    userHouse.set(e.discordId, e.house);
    let perDay = userDayDelta.get(e.discordId);
    if (!perDay) {
      perDay = new Map();
      userDayDelta.set(e.discordId, perDay);
    }
    perDay.set(e.day, (perDay.get(e.day) ?? 0) + e.points);
  }

  // Per-user cumulative series
  const userCumulative = new Map<string, number[]>();
  for (const [userId, perDay] of userDayDelta) {
    const series: number[] = [];
    let running = 0;
    for (const day of dayKeys) {
      running += perDay.get(day) ?? 0;
      series.push(running);
    }
    userCumulative.set(userId, series);
  }

  const houses = Object.keys(HOUSE_COLORS) as House[];
  const datasets = houses.map((house) => {
    const data: number[] = [];
    const userIds = [...userHouse].filter(([, h]) => h === house).map(([id]) => id);
    for (let i = 0; i < dayKeys.length; i++) {
      let sum = 0;
      let qualifying = 0;
      for (const id of userIds) {
        const val = userCumulative.get(id)?.[i] ?? 0;
        if (val > MIN_MONTHLY_POINTS_FOR_WEIGHTED) {
          sum += val;
          qualifying++;
        }
      }
      // Match PostgreSQL integer division used by getWeightedHousePoints.
      data.push(qualifying > 0 ? Math.trunc(sum / qualifying) : 0);
    }
    return { house, color: getHouseColor(house), data };
  });

  return { labels, datasets };
}
