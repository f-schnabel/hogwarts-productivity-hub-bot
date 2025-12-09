export const BOT_COLORS = {
  PRIMARY: 0x4b82f3,
  SUCCESS: 0x00c853,
  WARNING: 0xff8f00,
  ERROR: 0xd84315,
  INFO: 0x2196f3,
  SECONDARY: 0x757575,
  HEALTHY: 0x4caf50,
  PREMIUM: 0x9c27b0,
} as const;

export const HOUSE_COLORS = {
  Gryffindor: 0xff2000,
  Hufflepuff: 0xf8d301,
  Ravenclaw: 0x0178c8,
  Slytherin: 0x07ad34,
} as const;

export const HOUSE_EMOJIS = {
  Gryffindor: "🦁",
  Hufflepuff: "🦡",
  Ravenclaw: "🦅",
  Slytherin: "🐍",
} as const;

export const TASK_POINT_SCORE = 2;
export const DAILY_TASK_LIMIT = 10;
export const TASK_MIN_TIME = 20;

export const MIN_DAILY_MINUTES_FOR_STREAK = 15 * 60;
export const MIN_DAILY_MESSAGES_FOR_STREAK = 3;
export const FIRST_HOUR_POINTS = 5;
export const REST_HOURS_POINTS = 2;
export const MAX_HOURS_PER_DAY = 12;
