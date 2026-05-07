import dayjs from "dayjs";

export function isHouseStandingsMysteryMode(monthStart: Date, now = dayjs()): boolean {
  const isLastThreeDays = now.date() > now.daysInMonth() - 3;
  if (!isLastThreeDays) return false;

  return now.diff(monthStart, "day") > 1;
}
