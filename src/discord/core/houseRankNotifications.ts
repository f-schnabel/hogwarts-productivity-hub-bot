import { HOUSE_COLORS } from "@/common/constants.ts";
import type { House, HousePoints, RankedHousePoints } from "@/common/types.ts";
import { createLogger } from "@/common/logging/logger.ts";
import { client } from "@/discord/client.ts";
import { bold } from "discord.js";
import { getWeightedHousePointsForHouse, type DbOrTx, type getWeightedHousePoints } from "@/db/db.ts";
import { oneLineCommaListsAnd } from "common-tags";

const log = createLogger("HouseRankNotifications");
const YEAR_ANNOUNCEMENT_CHANNEL_ID = process.env.YEAR_ANNOUNCEMENT_CHANNEL_ID;

const ORDINAL_PLACES = ["the lead", "second place", "third place", "fourth place"] as const;

export interface HouseRankChangeNotification {
  house: House;
  description: string;
}

export function getHouseRankChangeNotifications(
  before: RankedHousePoints[],
  changedHouseAfter: HousePoints | undefined,
): HouseRankChangeNotification[] {
  if (!changedHouseAfter) return [];

  const after = rankHouses([
    ...before.filter((house) => house.house !== changedHouseAfter.house),
    changedHouseAfter,
  ]);

  return after
    .filter((houseAfter) => {
      const houseBefore = before.find((beforeHouse) => beforeHouse.house === houseAfter.house);
      if (!houseBefore) return false;
      if (houseAfter.rank < houseBefore.rank) return true;

      return houseAfter.house === changedHouseAfter.house &&
        before.some((other) => hasRankTie(other, houseBefore)) !==
        after.some((other) => hasRankTie(other, houseAfter));
    })
    .map((house) => {
      const tiedHouses = after
        .filter((other) => hasRankTie(other, house))
        .map((other) => other.house);

      return {
        house: house.house,
        description: formatRankChange(house.house, house.rank, tiedHouses),
      };
    });
}

export function rankHouses(houses: HousePoints[]): RankedHousePoints[] {
  const sortedHouses = houses.toSorted((a, b) => b.totalPoints - a.totalPoints);

  let rank = 0;
  return sortedHouses.map((house, index) => {
    const previousHouse = sortedHouses[index - 1];
    if (previousHouse?.totalPoints !== house.totalPoints) rank = index + 1;
    return { ...house, rank };
  });
}

export async function announceHouseRankChanges(
  db: DbOrTx,
  houseRanksBefore: Awaited<ReturnType<typeof getWeightedHousePoints>>,
  house: House | null | undefined,
): Promise<void> {
  if (!house) return;
  const notifications = getHouseRankChangeNotifications(houseRanksBefore, await getWeightedHousePointsForHouse(db, house));

  if (notifications.length === 0 || !YEAR_ANNOUNCEMENT_CHANNEL_ID) return;

  try {
    const channel = await client.channels.fetch(YEAR_ANNOUNCEMENT_CHANNEL_ID);
    if (!channel?.isSendable()) return;

    await channel.send({
      embeds: notifications.map((notification) => ({
        title: "Updates to the leaderboard",
        description: notification.description,
        color: HOUSE_COLORS[notification.house],
      })),
    });
  } catch (error) {
    log.error("Failed to send house rank change notification", undefined, error);
  }
}

function formatRankChange(house: House, rank: number, tiedHouses: House[]): string {
  const place = ORDINAL_PLACES[rank - 1] ?? `${rank}th place`;
  if (tiedHouses.length > 0) {
    return oneLineCommaListsAnd`${house} is now tied with ${tiedHouses} for ${bold(place)} in the house cup.`;
  }
  return rank === 1
    ? `${house} has taken ${bold(place)} in the house cup. Congratulations!`
    : `${house} took ${bold(place)} in the house cup.`;
}

function hasRankTie(other: RankedHousePoints, house: RankedHousePoints): boolean {
  return other.house !== house.house && other.rank === house.rank;
}
