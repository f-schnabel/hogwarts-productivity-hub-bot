import { HOUSES, MIN_MONTHLY_POINTS_FOR_WEIGHTED } from "@/common/constants.ts";
import type { House } from "@/common/types.ts";

export interface HouseWhatIfUser {
  discordId: string;
  house: House | null;
  monthlyPoints: number;
}

export interface HouseWhatIfRow {
  house: House;
  currentPoints: number;
  projectedPoints: number;
  currentMemberCount: number;
  projectedMemberCount: number;
}

interface HouseTotals {
  points: number;
  memberCount: number;
}

export function calculateHouseWhatIf(
  users: HouseWhatIfUser[],
  discordId: string,
  targetHouse: House,
): HouseWhatIfRow[] {
  const current = calculateHouseTotals(users);
  const projected = calculateHouseTotals(
    users.map((user) => user.discordId === discordId ? { ...user, house: targetHouse } : user),
  );

  return HOUSES.map((house) => ({
    house,
    currentPoints: weightedPoints(current.get(house)),
    projectedPoints: weightedPoints(projected.get(house)),
    currentMemberCount: current.get(house)?.memberCount ?? 0,
    projectedMemberCount: projected.get(house)?.memberCount ?? 0,
  })).sort((a, b) =>
    b.projectedPoints - a.projectedPoints || HOUSES.indexOf(a.house) - HOUSES.indexOf(b.house),
  );
}

function calculateHouseTotals(users: HouseWhatIfUser[]): Map<House, HouseTotals> {
  const totals = new Map<House, HouseTotals>();

  for (const user of users) {
    if (!user.house || user.monthlyPoints < MIN_MONTHLY_POINTS_FOR_WEIGHTED) continue;

    const house = totals.get(user.house) ?? { points: 0, memberCount: 0 };
    house.points += user.monthlyPoints;
    house.memberCount++;
    totals.set(user.house, house);
  }

  return totals;
}

function weightedPoints(totals: HouseTotals | undefined): number {
  return totals ? Math.trunc(totals.points / totals.memberCount) : 0;
}
