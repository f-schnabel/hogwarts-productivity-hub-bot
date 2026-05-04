import { describe, expect, it } from "vitest";
import { getHouseRankChangeNotifications } from "@/discord/core/houseRankNotifications.ts";
import type { House, RankedHousePoints } from "@/common/types.ts";

describe("House rank notifications", () => {
  it("builds a concise message when houses switch places", () => {
    const notifications = getHouseRankChangeNotifications(
      [rankedHouse("Hufflepuff", 50, 1), rankedHouse("Slytherin", 45, 2)],
      rankedHouse("Slytherin", 55, 1),
    );

    expect(notifications).toEqual([{
      house: "Slytherin",
      description: "Slytherin has taken **the lead** in the house cup. Congratulations!",
    }]);
  });

  it("does not notify when rankings stay the same", () => {
    const notifications = getHouseRankChangeNotifications(
      [rankedHouse("Hufflepuff", 50, 1), rankedHouse("Slytherin", 45, 2)],
      rankedHouse("Hufflepuff", 60, 1),
    );

    expect(notifications).toEqual([]);
  });

  it("does not notify when a house enters without moving another house", () => {
    const notifications = getHouseRankChangeNotifications(
      [rankedHouse("Hufflepuff", 50, 1)],
      rankedHouse("Slytherin", 45, 1),
    );

    expect(notifications).toEqual([]);
  });

  it("notifies when a house ties the leader by improving its rank", () => {
    const notifications = getHouseRankChangeNotifications(
      [rankedHouse("Hufflepuff", 50, 1), rankedHouse("Slytherin", 45, 2)],
      rankedHouse("Slytherin", 50, 1),
    );

    expect(notifications).toEqual([{
      house: "Slytherin",
      description: "Slytherin is now tied with Hufflepuff for **the lead** in the house cup.",
    }]);
  });

  it("mentions every house tied at the improved rank", () => {
    const notifications = getHouseRankChangeNotifications(
      [
        rankedHouse("Hufflepuff", 60, 1),
        rankedHouse("Gryffindor", 50, 2),
        rankedHouse("Ravenclaw", 50, 2),
        rankedHouse("Slytherin", 45, 4),
      ],
      rankedHouse("Slytherin", 50, 1),
    );

    expect(notifications).toEqual([{
      house: "Slytherin",
      description: "Slytherin is now tied with Gryffindor and Ravenclaw for **second place** in the house cup.",
    }]);
  });

  it("notifies when a house breaks a tie without changing rank", () => {
    const notifications = getHouseRankChangeNotifications(
      [rankedHouse("Hufflepuff", 50, 1), rankedHouse("Slytherin", 50, 1)],
      rankedHouse("Slytherin", 55, 1),
    );

    expect(notifications).toEqual([{
      house: "Slytherin",
      description: "Slytherin has taken **the lead** in the house cup. Congratulations!",
    }]);
  });

  it("notifies when a house drops into a tie", () => {
    const notifications = getHouseRankChangeNotifications(
      [rankedHouse("Hufflepuff", 60, 1), rankedHouse("Slytherin", 55, 2), rankedHouse("Ravenclaw", 50, 3)],
      rankedHouse("Slytherin", 50, 1),
    );

    expect(notifications).toEqual([{
      house: "Ravenclaw",
      description: "Ravenclaw is now tied with Slytherin for **second place** in the house cup.",
    }]);
  });

  it("notifies only houses that gain rank when another house loses standing", () => {
    const notifications = getHouseRankChangeNotifications(
      [
        rankedHouse("Hufflepuff", 50, 1),
        rankedHouse("Slytherin", 45, 2),
        rankedHouse("Ravenclaw", 40, 3),
      ],
      rankedHouse("Slytherin", 35, 1),
    );

    expect(notifications).toEqual([{
      house: "Ravenclaw",
      description: "Ravenclaw took **second place** in the house cup.",
    }]);
  });
});

function rankedHouse(house: House, totalPoints: number, rank: number): RankedHousePoints {
  return { house, totalPoints, memberCount: 1, rank };
}
