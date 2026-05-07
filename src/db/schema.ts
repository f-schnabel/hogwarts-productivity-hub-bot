import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  serial,
  text,
  uniqueIndex,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { HOUSES } from "@/common/constants.ts";

export const houseEnum = pgEnum("house", HOUSES);

export const userTable = pgTable("user", {
  // Technical fields
  discordId: varchar({ length: 255 }).primaryKey().notNull(),
  createdAt: timestamp().notNull().defaultNow(),
  updatedAt: timestamp().notNull().defaultNow().$onUpdate(() => new Date()),
  username: varchar({ length: 255 }).notNull(),

  // User customization fields
  house: houseEnum(),
  timezone: varchar({ length: 50 }).default("UTC").notNull(),
  lastDailyReset: timestamp().defaultNow().notNull(),

  // Score fields
  dailyPoints: integer().default(0).notNull(),
  monthlyPoints: integer().default(0).notNull(),
  totalPoints: integer().default(0).notNull(),

  dailyVoiceTime: integer().default(0).notNull(),
  monthlyVoiceTime: integer().default(0).notNull(),
  totalVoiceTime: integer().default(0).notNull(),

  dailyMessages: integer().default(0).notNull(),
  messageStreak: integer().default(0).notNull(),
  announcedYear: integer().default(0).notNull(),
}, (table) => [index("user_house_monthly_points_idx").on(table.house, table.monthlyPoints.desc())],
);

export const voiceSessionTable = pgTable(
  "voice_session",
  {
    // Technical fields
    id: serial().primaryKey(),
    discordId: varchar({ length: 255 }).notNull().references(() => userTable.discordId, { onDelete: "cascade" }),

    joinedAt: timestamp().notNull().defaultNow(),
    leftAt: timestamp(),
    channelId: varchar({ length: 255 }).notNull(),
    channelName: varchar({ length: 255 }).notNull(),

    // if points and voiceTime were awarded for this session
    isTracked: boolean().default(false).notNull(),
    points: integer(),

    // in seconds
    duration: integer().generatedAlwaysAs(sql`EXTRACT(EPOCH FROM (left_at - joined_at))`),
    creditedDuration: integer(),
  },
  (table) => [index("voice_session_discord_id_left_at_idx").on(table.discordId, table.leftAt)],
);

export const pomodoroSessionTable = pgTable(
  "pomodoro_session",
  {
    id: serial().primaryKey(),
    channelId: varchar({ length: 255 }).notNull(),
    channelName: varchar({ length: 255 }).notNull(),
    focusMinutes: integer().notNull(),
    breakMinutes: integer().notNull(),
    stage: varchar({ length: 10, enum: ["FOCUS", "BREAK"] }).notNull(),
    stageStartedAt: timestamp().notNull().defaultNow(),
    nextStageAt: timestamp().notNull(),
    startedAt: timestamp().notNull().defaultNow(),
    endedAt: timestamp(),
    statusMessageId: varchar({ length: 255 }),
  },
  (table) => [
    index("pomodoro_session_channel_id_ended_at_idx").on(table.channelId, table.endedAt),
    uniqueIndex("pomodoro_session_status_message_id_idx").on(table.statusMessageId),
    uniqueIndex("pomodoro_session_active_channel_id_idx")
      .on(table.channelId)
      .where(sql`${table.endedAt} IS NULL`),
  ],
);

export const submissionTypeEnum = pgEnum("submission_type", ["NEW", "COMPLETED"]);
export const submissionStatusEnum = pgEnum("submission_status", ["PENDING", "APPROVED", "REJECTED", "CANCELED"]);

// Holds submission data so approvals/rejections persist bot restarts
export const submissionTable = pgTable(
  "submission",
  {
    // Technical fields
    id: serial().primaryKey(),
    discordId: varchar({ length: 255 }).notNull().references(() => userTable.discordId, { onDelete: "cascade" }),
    submittedAt: timestamp().notNull().defaultNow(),
    reviewedAt: timestamp(),
    reviewedBy: varchar({ length: 255 }),

    // Discord message reference fields (for cross-linking)
    messageId: varchar({ length: 255 }).unique(),
    channelId: varchar({ length: 255 }),

    // Submission fields
    house: houseEnum().notNull(),
    houseId: integer().notNull(),
    screenshotUrl: varchar({ length: 1000 }).notNull(),
    points: integer().notNull(),
    submissionType: submissionTypeEnum(),
    status: submissionStatusEnum().default("PENDING").notNull(),
    // Self-reference to link finish submission to its start submission
    linkedSubmissionId: integer(),
  },
  (table) => [
    foreignKey({ columns: [table.linkedSubmissionId], foreignColumns: [table.id] }),
    index("submission_discordId_status_submitted_at_idx").on(table.discordId, table.status, table.submittedAt),
    index("submission_house_submitted_at_idx").on(table.house, table.submittedAt),
  ],
);

// Holds message ids to be updated for house scoreboards
export const houseScoreboardTable = pgTable("house_scoreboard", {
  id: serial().primaryKey(),
  house: houseEnum().notNull(),
  channelId: text().notNull(),
  messageId: text().notNull(),
  updatedAt: timestamp().defaultNow().notNull(),
});


// Stores global settings
export const settingsTable = pgTable("settings", {
  key: varchar({ length: 255 }).primaryKey().notNull(),
  value: text().notNull(),
});

// Tracks house cup results per month (snapshot before monthly reset)
export const houseCupMonthTable = pgTable("house_cup_month", {
  id: serial().primaryKey(),
  month: varchar({ length: 7 }).notNull().unique(), // "2026-03" format
  winner: houseEnum().notNull(),
  createdAt: timestamp().notNull().defaultNow(),
});

// Per-house stats for each house cup month
export const houseCupEntryTable = pgTable(
  "house_cup_entry",
  {
    id: serial().primaryKey(),
    monthId: integer().notNull().references(() => houseCupMonthTable.id, { onDelete: "cascade" }),
    house: houseEnum().notNull(),
    weightedPoints: integer().notNull(),
    rawPoints: integer().notNull(),
    memberCount: integer().notNull(),
    qualifyingCount: integer().notNull(),
    champion: varchar({ length: 255 }).references(() => userTable.discordId),
  },
  (table) => [index("house_cup_entry_month_id_idx").on(table.monthId)],
);

// Tracks manual point adjustments by admins
export const pointAdjustmentTable = pgTable("point_adjustment", {
  id: serial().primaryKey(),
  discordId: varchar({ length: 255 }).notNull().references(() => userTable.discordId, { onDelete: "cascade" }),
  adjustedBy: varchar({ length: 255 }).notNull(),
  amount: integer().notNull(),
  reason: text(),
  createdAt: timestamp().notNull().defaultNow(),
}, (table) => [index("point_adjustment_discord_id_created_at_idx").on(table.discordId)]);

export const journalEntryTable = pgTable(
  "journal_entry",
  {
    id: serial().primaryKey(),
    date: date("date", { mode: "string" }).notNull(),
    prompt: text().notNull(),
    messageId: text(),
    createdAt: timestamp().notNull().defaultNow(),
    updatedAt: timestamp().notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (table) => [uniqueIndex("journal_entry_date_idx").on(table.date)],
);
