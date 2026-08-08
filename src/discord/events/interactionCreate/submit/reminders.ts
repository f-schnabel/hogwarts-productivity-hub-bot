import dayjs from "dayjs";
import { SUBMISSION_TYPES } from "@/common/constants.ts";

export const REMINDER_ACTIVE_STATUSES = ["PENDING", "APPROVED"] as const;

export function canSetSubmissionReminder(submission: {
  status: string;
  submissionType: string | null;
  reminderAt: Date | null;
}): boolean {
  return (
    REMINDER_ACTIVE_STATUSES.some((status) => status === submission.status) &&
    submission.submissionType === SUBMISSION_TYPES.NEW &&
    submission.reminderAt === null
  );
}

export interface ReminderOption {
  label: string;
  value: string;
}

export function getReminderOptions(timezone: string, now: dayjs.Dayjs = dayjs()): ReminderOption[] {
  const localNow = now.tz(timezone);
  const localEndOfDay = localNow.endOf("day");
  const options: ReminderOption[] = [];
  let tick = now.utc().startOf("hour").add(1, "hour");

  while (options.length < 25) {
    const localTick = tick.tz(timezone);
    if (!localTick.isSame(localNow, "day")) break;
    if (localTick.isAfter(localEndOfDay)) break;

    options.push({
      label: localTick.format("h:mm A (z)"),
      value: tick.toISOString(),
    });

    tick = tick.add(1, "hour");
  }

  return options;
}

export function validateReminderValue(value: string, timezone: string, now: dayjs.Dayjs = dayjs()): Date | null {
  const option = getReminderOptions(timezone, now).find((option) => option.value === value);
  return option ? new Date(option.value) : null;
}
