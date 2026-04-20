import { describe, expect, it } from "vitest";
import { normalizeOffset, asOffsetQuery, scoreTimezones } from "@/discord/core/timezone.ts";

describe("normalizeOffset", () => {
  it("is identity for already-normalized offsets", () => {
    expect(normalizeOffset("+05:30")).toBe("+05:30");
    expect(normalizeOffset("-11:00")).toBe("-11:00");
    expect(normalizeOffset("+00:00")).toBe("+00:00");
    expect(normalizeOffset("-09:30")).toBe("-09:30");
  });

  it("zero-pads the hour", () => {
    expect(normalizeOffset("+5:30")).toBe("+05:30");
    expect(normalizeOffset("-1:00")).toBe("-01:00");
    expect(normalizeOffset("+0:00")).toBe("+00:00");
  });

  it("adds + sign when missing", () => {
    expect(normalizeOffset("05:30")).toBe("+05:30");
    expect(normalizeOffset("5:30")).toBe("+05:30");
    expect(normalizeOffset("00:00")).toBe("+00:00");
  });

  it("adds :00 when minutes are missing", () => {
    expect(normalizeOffset("5")).toBe("+05:00");
    expect(normalizeOffset("+5")).toBe("+05:00");
    expect(normalizeOffset("-5")).toBe("-05:00");
    expect(normalizeOffset("11")).toBe("+11:00");
  });
});

describe("asOffsetQuery", () => {
  it("returns normalized offset for offset-like words", () => {
    expect(asOffsetQuery("05:30")).toBe("+05:30");
    expect(asOffsetQuery("+05:30")).toBe("+05:30");
    expect(asOffsetQuery("-01:00")).toBe("-01:00");
    expect(asOffsetQuery("5:30")).toBe("+05:30");
    expect(asOffsetQuery("0:00")).toBe("+00:00");
    expect(asOffsetQuery("5")).toBe("+05:00");
    expect(asOffsetQuery("+5")).toBe("+05:00");
  });

  it("returns null for non-offset words", () => {
    expect(asOffsetQuery("london")).toBeNull();
    expect(asOffsetQuery("ist")).toBeNull();
    expect(asOffsetQuery("europe/london")).toBeNull();
    expect(asOffsetQuery("new york")).toBeNull();
  });
});

describe("scoreTimezones offset matching", () => {
  const values = (results: { value: string }[]) => results.map((r) => r.value);

  describe("offset formats all match the same timezone", () => {
    // Asia/Kolkata is the canonical UTC+05:30 timezone
    it("matches with leading zero: 05:30", () => {
      expect(values(scoreTimezones(["05:30"]))).toContain("Asia/Kolkata");
    });

    it("matches without leading zero: 5:30", () => {
      expect(values(scoreTimezones(["5:30"]))).toContain("Asia/Kolkata");
    });

    it("matches with explicit plus: +05:30", () => {
      expect(values(scoreTimezones(["+05:30"]))).toContain("Asia/Kolkata");
    });

    it("matches with explicit plus, no leading zero: +5:30", () => {
      expect(values(scoreTimezones(["+5:30"]))).toContain("Asia/Kolkata");
    });
  });

  describe("no false positives from substring collisions", () => {
    it("0:00 does not match +10:00 timezones", () => {
      const results = scoreTimezones(["0:00"]);
      const vals = values(results);
      // All results should be UTC+0 offsets, not +10:xx
      for (const r of results) {
        expect(r.score).toBeGreaterThan(0);
      }
      // Australia/Sydney is UTC+10 or +11 — must not appear for "0:00"
      expect(vals).not.toContain("Australia/Sydney");
    });

    it("1:00 does not match +10:00 or +11:00 timezones", () => {
      const vals = values(scoreTimezones(["1:00"]));
      expect(vals).not.toContain("Australia/Sydney");
      expect(vals).not.toContain("Pacific/Auckland");
    });
  });

  describe("negative offsets", () => {
    it("-05:00 matches US Eastern timezone", () => {
      expect(values(scoreTimezones(["-05:00"]))).toContain("America/New_York");
    });

    it("-5:00 also matches US Eastern timezone", () => {
      expect(values(scoreTimezones(["-5:00"]))).toContain("America/New_York");
    });

    it("-05:00 does not match +05:00 timezones", () => {
      // Pakistan is UTC+5:00
      const vals = values(scoreTimezones(["-05:00"]));
      expect(vals).not.toContain("Asia/Karachi");
    });
  });

  describe("unsigned offset is treated as positive", () => {
    it("5:00 matches +05:00 but not -05:00 timezones", () => {
      const vals = values(scoreTimezones(["5:00"]));
      expect(vals).toContain("Asia/Karachi"); // UTC+5
      expect(vals).not.toContain("America/New_York"); // UTC-5
    });

    it("5 (no minutes) matches +05:00 timezones", () => {
      const vals = values(scoreTimezones(["5"]));
      expect(vals).toContain("Asia/Karachi"); // UTC+5:00
    });
  });

  describe("non-offset matching still works", () => {
    it("matches by timezone name", () => {
      expect(values(scoreTimezones(["london"]))).toContain("Europe/London");
    });

    it("matches by abbreviation", () => {
      // IST = Indian Standard Time
      expect(values(scoreTimezones(["ist"]))).toContain("Asia/Kolkata");
    });

    it("matches by country", () => {
      expect(values(scoreTimezones(["germany"]))).toContain("Europe/Berlin");
    });

    it("matches by city", () => {
      expect(values(scoreTimezones(["paris"]))).toContain("Europe/Paris");
    });
  });

  describe("offset scores higher than name/city matches", () => {
    it("exact offset match outscores partial name match", () => {
      const results = scoreTimezones(["+5:30"]);
      const kolkataIndex = values(results).indexOf("Asia/Kolkata");
      expect(kolkataIndex).toBeGreaterThanOrEqual(0);
      expect(kolkataIndex).toBeLessThan(5); // should be near the top
    });
  });

  describe("empty query", () => {
    it("returns empty array for no words", () => {
      expect(scoreTimezones([])).toHaveLength(0);
    });
  });
});
