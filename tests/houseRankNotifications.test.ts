import { describe, expect, it } from "vitest";
import { getHouseRankChangeNotification } from "@/discord/core/houseRankNotifications.ts";
import type { HousePoints, RankedHousePoints } from "@/common/types.ts";

describe("House rank notifications", () => {
  it("builds a concise message when houses switch places", () => {
    const notification = getHouseRankChangeNotification(
      [rankedHouse("Hufflepuff", 50, 1), rankedHouse("Slytherin", 45, 2)],
      house("Slytherin", 55),
    );

    expect(notification).toEqual({
      house: "Slytherin",
      description: "Slytherin has taken **the lead** in the house cup. Congratulations!",
    });
  });

  it("does not notify when rankings stay the same", () => {
    const notification = getHouseRankChangeNotification(
      [rankedHouse("Hufflepuff", 50, 1), rankedHouse("Slytherin", 45, 2)],
      house("Hufflepuff", 60),
    );

    expect(notification).toBeNull();
  });

  it("does not notify when a house enters without moving another house", () => {
    const notification = getHouseRankChangeNotification(
      [rankedHouse("Hufflepuff", 50, 1)],
      house("Slytherin", 45),
    );

    expect(notification).toBeNull();
  });

  it("notifies when a house ties the leader by improving its rank", () => {
    const notification = getHouseRankChangeNotification(
      [rankedHouse("Hufflepuff", 50, 1), rankedHouse("Slytherin", 45, 2)],
      house("Slytherin", 50),
    );

    expect(notification).toEqual({
      house: "Slytherin",
      description: "Slytherin has taken **the lead** in the house cup. Congratulations!",
    });
  });
});

function house(house: HousePoints["house"], totalPoints: number): HousePoints {
  return { house, totalPoints, memberCount: 1 };
}

function rankedHouse(houseName: HousePoints["house"], totalPoints: number, rank: number): RankedHousePoints {
  return { ...house(houseName, totalPoints), rank };
}
