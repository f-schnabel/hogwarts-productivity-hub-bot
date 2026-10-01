import type { Sums } from "@/common/types.ts";

export interface IntegrityValues {
  points: Sums;
  voiceTime: Sums;
}

export interface IntegrityRow {
  username: string;
  stored: IntegrityValues;
  expected: IntegrityValues;
}

const PERIODS = [
  ["total", "T"],
  ["monthly", "M"],
  ["daily", "D"],
] as const;

// Short voice time for the report, e.g. "10h19m"
function formatHours(seconds: number): string {
  const sign = seconds < 0 ? "-" : "";
  const minutes = Math.floor(Math.abs(seconds) / 60);
  return `${sign}${Math.floor(minutes / 60)}h${(minutes % 60).toString().padStart(2, "0")}m`;
}

function diffs(stored: Sums, expected: Sums, format: (value: number) => string): string[] {
  return PERIODS.filter(([period]) => stored[period] !== expected[period]).map(
    ([period, label]) => `${label} ${format(stored[period])}→${format(expected[period])}`,
  );
}

/** One line per user with mismatches, e.g. "**name** pts T 583→581 M 28→19 · vc M 10h19m→7h40m" */
export function formatIntegrityLine({ username, stored, expected }: IntegrityRow): string | null {
  const points = diffs(stored.points, expected.points, String);
  const voiceTime = diffs(stored.voiceTime, expected.voiceTime, formatHours);
  if (points.length === 0 && voiceTime.length === 0) return null;

  const parts = [];
  if (points.length > 0) parts.push(`pts ${points.join(" ")}`);
  if (voiceTime.length > 0) parts.push(`vc ${voiceTime.join(" ")}`);
  return `**${username}** ${parts.join(" · ")}`;
}

/** Discord message for the integrity check, cut off before `maxLength` with a count of the users left out */
export function formatIntegrityReport(rows: IntegrityRow[], maxLength = 2000): string {
  const lines = rows.map(formatIntegrityLine).filter((line) => line !== null);
  if (lines.length === 0) return "✅ No discrepancies found.";

  const header = `⚠️ ${lines.length} user(s) with discrepancies (stored→expected; T/M/D = total/monthly/daily):`;
  let message = header;
  for (const [i, line] of lines.entries()) {
    const remaining = lines.length - i - 1;
    const footer = remaining > 0 ? `\n…and ${remaining} more` : "";
    if (message.length + 1 + line.length + footer.length > maxLength) {
      return `${message}\n…and ${lines.length - i} more`;
    }
    message += `\n${line}`;
  }
  return message;
}
