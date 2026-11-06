import dayjs from "dayjs";

export function getSubmissionDayBounds(timezone: string, now: dayjs.Dayjs = dayjs()) {
  const dayStart = now.tz(timezone).startOf("day");
  const dayEnd = dayStart.add(1, "day").startOf("day");
  return { dayStart, dayEnd };
}
