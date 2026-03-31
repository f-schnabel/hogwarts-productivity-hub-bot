import { describe, expect, it } from "vitest";
import { parseJournalCsv, serializeJournalCsv, validateJournalDate } from "../src/services/journalCsv.ts";

describe("validateJournalDate", () => {
  it("accepts valid YYYY-MM-DD dates", () => {
    expect(validateJournalDate("2026-04-01")).toBe("2026-04-01");
  });

  it("rejects invalid calendar dates", () => {
    expect(validateJournalDate("2026-02-30")).toBeNull();
    expect(validateJournalDate("04-01-2026")).toBeNull();
  });
});

describe("serializeJournalCsv", () => {
  it("serializes a header and escapes prompts", () => {
    const csv = serializeJournalCsv([
      { date: "2026-04-01", prompt: "Simple prompt" },
      { date: "2026-04-02", prompt: 'Prompt with, comma and "quotes"' },
    ]);

    expect(csv).toBe('date,prompt\n2026-04-01,Simple prompt\n2026-04-02,"Prompt with, comma and ""quotes"""\n');
  });
});

describe("parseJournalCsv", () => {
  it("parses quoted prompts with commas and newlines", () => {
    const rows = parseJournalCsv('date,prompt\n2026-04-01,"Line 1\nLine 2, still prompt"');

    expect(rows).toEqual([{ date: "2026-04-01", prompt: "Line 1\nLine 2, still prompt" }]);
  });

  it("rejects invalid headers", () => {
    expect(() => parseJournalCsv("scheduled_for,prompt\n2026-04-01,test")).toThrow(
      "CSV header must be exactly: date,prompt",
    );
  });

  it("rejects invalid dates", () => {
    expect(() => parseJournalCsv("date,prompt\n2026-02-30,test")).toThrow("Row 2 has an invalid date: 2026-02-30");
  });

  it("rejects empty prompts", () => {
    expect(() => parseJournalCsv("date,prompt\n2026-04-01,   ")).toThrow("Row 2 has an empty prompt.");
  });
});
