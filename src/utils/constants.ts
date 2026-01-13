import type { House } from "../types.ts";

export const BOT_COLORS = {
  SUCCESS: 0x00c853,
  WARNING: 0xff8f00,
  ERROR: 0xd84315,
  INFO: 0x2196f3,
} as const;

export const HOUSE_COLORS = {
  Gryffindor: 0xff2000,
  Hufflepuff: 0xf8d301,
  Ravenclaw: 0x110091,
  Slytherin: 0x07ad34,
} as const;

export const SUBMISSION_COLORS = {
  PENDING: 0x979c9f,
  APPROVED: 0x2ecc70,
  REJECTED: 0xe74d3c,
} as const;

export const Role = {
  OWNER: 1 << 0,
  PREFECT: 1 << 1,
  PROFESSOR: 1 << 2,
} as const;

export const DEFAULT_SUBMISSION_POINTS = 5;
export const MIN_DAILY_MESSAGES_FOR_STREAK = 3;
export const FIRST_HOUR_POINTS = 5;
export const REST_HOURS_POINTS = 2;
export const MAX_HOURS_PER_DAY = 12;

export const SETTINGS_KEYS = {
  LAST_MONTHLY_RESET: "lastMonthlyReset",
  VC_EMOJI: "vcEmoji",
} as const;

// Max age for a session to be resumed (24 hours)
export const MAX_SESSION_AGE_MS = 24 * 60 * 60 * 1000;

export const MIN_USERS_FOR_SAFE_DELETION = 100;

// Thresholds in hours, index = year - 1
export type YEAR = 1 | 2 | 3 | 4 | 5 | 6 | 7;
export const YEAR_THRESHOLDS_HOURS = [1, 10, 20, 40, 80, 100, 120] as const;

export const YEAR_MESSAGES: Record<House, string> = {
  Gryffindor: "🦁 True courage lies in perseverance. You rise to {ROLE} with **{HOURS}** of steadfast effort.",
  Slytherin: "🐍 Ambition well applied brings results. {ROLE} claimed after **{HOURS}** of focused study.",
  Hufflepuff: "🌟 Your consistency shines brightest. {ROLE} earned through **{HOURS}** in the study halls.",
  Ravenclaw: "✒️ Each hour sharpened your mind — {ROLE} is now yours after **{HOURS}**. Wisdom suits you.",
} as const;
