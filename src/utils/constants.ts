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
  Ravenclaw: 0x110091,
  Slytherin: 0x07ad34,
} as const;

export const MIN_DAILY_MESSAGES_FOR_STREAK = 3;
export const FIRST_HOUR_POINTS = 5;
export const REST_HOURS_POINTS = 2;
export const MAX_HOURS_PER_DAY = 12;

export const SETTINGS_KEYS = {
  LAST_MONTHLY_RESET: "lastMonthlyReset",
} as const;
