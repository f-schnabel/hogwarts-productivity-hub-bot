import { describe, expect, it } from "vitest";
import { formatIntegrityLine, formatIntegrityReport, type IntegrityRow } from "@/discord/core/integrityReport.ts";

const row = (username: string, overrides: Partial<IntegrityRow["expected"]> = {}): IntegrityRow => {
  const stored = {
    points: { total: 583, monthly: 28, daily: 5 },
    voiceTime: { total: 360000, monthly: 37151, daily: 3600 },
  };
  return { username, stored, expected: { ...stored, ...overrides } };
};

describe("formatIntegrityLine", () => {
  it("returns null without discrepancies", () => {
    expect(formatIntegrityLine(row("ok"))).toBeNull();
  });

  it("puts all mismatches of a user on one line", () => {
    const line = formatIntegrityLine(
      row("msaidhey", {
        points: { total: 581, monthly: 19, daily: 5 },
        voiceTime: { total: 360000, monthly: 27606, daily: 3600 },
      }),
    );

    expect(line).toBe("**msaidhey** pts T 583→581 M 28→19 · vc M 10h19m→7h40m");
  });
});

describe("formatIntegrityReport", () => {
  it("reports no discrepancies", () => {
    expect(formatIntegrityReport([row("ok")])).toBe("✅ No discrepancies found.");
  });

  it("stays within the length limit and counts the users left out", () => {
    const rows = Array.from({ length: 100 }, (_, i) =>
      row(`user${i}`, { points: { total: 1, monthly: 2, daily: 3 } }),
    );

    const message = formatIntegrityReport(rows, 500);

    expect(message.length).toBeLessThanOrEqual(500);
    expect(message).toMatch(/^⚠️ 100 user\(s\) with discrepancies/);
    const shown = message.split("\n").filter((line) => line.startsWith("**")).length;
    expect(message).toContain(`…and ${100 - shown} more`);
  });
});
