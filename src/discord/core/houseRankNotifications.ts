import { HOUSE_COLORS } from "@/common/constants.ts";
import type { House, HousePoints, RankedHousePoints } from "@/common/types.ts";
import { createLogger } from "@/common/logging/logger.ts";
import { client } from "@/discord/client.ts";
import { bold } from "discord.js";

const log = createLogger("HouseRankNotifications");
const YEAR_ANNOUNCEMENT_CHANNEL_ID = process.env.YEAR_ANNOUNCEMENT_CHANNEL_ID;

const ORDINAL_PLACES = ["the lead", "second place", "third place", "fourth place"] as const;

export interface HouseRankChangeNotification {
  house: House;
  description: string;
}

export function getHouseRankChangeNotification(
  before: RankedHousePoints[],
  changedHouseAfter: HousePoints | undefined,
): HouseRankChangeNotification | null {
  if (!changedHouseAfter) return null;

  const rankBefore = before.find((house) => house.house === changedHouseAfter.house)?.rank;
  if (rankBefore === undefined) return null;

  const rankAfter = getRankAfterPointChange(before, changedHouseAfter);
  return rankAfter < rankBefore
    ? { house: changedHouseAfter.house, description: formatRankChange(changedHouseAfter.house, rankAfter) }
    : null;
}

export async function announceHouseRankChanges(notification: HouseRankChangeNotification | null): Promise<void> {
  if (!notification || !YEAR_ANNOUNCEMENT_CHANNEL_ID) return;

  try {
    const channel = await client.channels.fetch(YEAR_ANNOUNCEMENT_CHANNEL_ID);
    if (!channel?.isSendable()) return;

    await channel.send({
      embeds: [{
        title: "Weighted House Standings Shift",
        description: notification.description,
        color: HOUSE_COLORS[notification.house],
      }],
    });
  } catch (error) {
    log.error("Failed to send house rank change notification", undefined, error);
  }
}

function formatRankChange(house: House, rank: number): string {
  const place = ORDINAL_PLACES[rank - 1] ?? `${rank}th place`;
  return rank === 1
    ? `${house} has taken ${bold(place)} in the house cup. Congratulations!`
    : `${house} took ${bold(place)} in the house cup.`;
}

function getRankAfterPointChange(before: RankedHousePoints[], changedHouseAfter: HousePoints): number {
  return before.filter((house) =>
    house.house !== changedHouseAfter.house && house.totalPoints > changedHouseAfter.totalPoints,
  ).length + 1;
}
