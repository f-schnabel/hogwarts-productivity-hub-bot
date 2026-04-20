import { YEAR_THRESHOLDS_HOURS, type YEAR } from "@/common/constants.ts";

export function getYearFromMonthlyVoiceTime(seconds: number): YEAR | null {
  const hours = seconds / 3600;

  for (const year of [7, 6, 5, 4, 3, 2, 1] as const) {
    const threshold = YEAR_THRESHOLDS_HOURS[year - 1];
    if (threshold !== undefined && hours >= threshold) return year;
  }

  return null;
}
