import { describe, expect, it } from "vitest";
import { calculateHouseWhatIf, type HouseWhatIfUser } from "@/discord/core/houseWhatIf.ts";

const users: HouseWhatIfUser[] = [
  { discordId: "moving", house: "Gryffindor", monthlyPoints: 60 },
  { discordId: "gryffindor", house: "Gryffindor", monthlyPoints: 40 },
  { discordId: "ravenclaw", house: "Ravenclaw", monthlyPoints: 100 },
  { discordId: "below-threshold", house: "Slytherin", monthlyPoints: 29 },
];

describe("calculateHouseWhatIf", () => {
  it("moves a qualifying user's points and divisor between houses", () => {
    expect(calculateHouseWhatIf(users, "moving", "Ravenclaw")).toEqual([
      {
        house: "Ravenclaw",
        currentPoints: 100,
        projectedPoints: 80,
        currentMemberCount: 1,
        projectedMemberCount: 2,
      },
      {
        house: "Gryffindor",
        currentPoints: 50,
        projectedPoints: 40,
        currentMemberCount: 2,
        projectedMemberCount: 1,
      },
      {
        house: "Hufflepuff",
        currentPoints: 0,
        projectedPoints: 0,
        currentMemberCount: 0,
        projectedMemberCount: 0,
      },
      {
        house: "Slytherin",
        currentPoints: 0,
        projectedPoints: 0,
        currentMemberCount: 0,
        projectedMemberCount: 0,
      },
    ]);
  });

  it("does not alter weighted scores for a user below the threshold", () => {
    const result = calculateHouseWhatIf(users, "below-threshold", "Hufflepuff");

    expect(result.map(({ house, currentPoints, projectedPoints }) => ({
      house,
      currentPoints,
      projectedPoints,
    }))).toEqual([
      { house: "Ravenclaw", currentPoints: 100, projectedPoints: 100 },
      { house: "Gryffindor", currentPoints: 50, projectedPoints: 50 },
      { house: "Hufflepuff", currentPoints: 0, projectedPoints: 0 },
      { house: "Slytherin", currentPoints: 0, projectedPoints: 0 },
    ]);
  });

  it("truncates projected averages like the database query", () => {
    const result = calculateHouseWhatIf([
      { discordId: "moving", house: "Gryffindor", monthlyPoints: 31 },
      { discordId: "ravenclaw", house: "Ravenclaw", monthlyPoints: 30 },
    ], "moving", "Ravenclaw");

    expect(result[0]).toMatchObject({ house: "Ravenclaw", projectedPoints: 30, projectedMemberCount: 2 });
  });
});
