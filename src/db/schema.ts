import { sql } from "drizzle-orm";
import { boolean, index, integer, pgTable, serial, timestamp, text, varchar } from "drizzle-orm/pg-core";

export const userTable = pgTable("user", {
  // Technical fields
  discordId: varchar({ length: 255 }).primaryKey().notNull(),
  createdAt: timestamp().notNull().defaultNow(),
  updatedAt: timestamp()
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  username: varchar({ length: 255 }).notNull(),

  // User customization fields
  house: varchar({
    length: 50,
    enum: ["Gryffindor", "Hufflepuff", "Ravenclaw", "Slytherin"],
  }),
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
  isMessageStreakUpdatedToday: boolean().default(false).notNull(),
});

export const voiceSessionTable = pgTable(
  "voice_session",
  {
    // Technical fields
    id: serial().primaryKey(),
    discordId: varchar({ length: 255 })
      .notNull()
      .references(() => userTable.discordId),

    joinedAt: timestamp().notNull().defaultNow(),
    leftAt: timestamp(),
    channelId: varchar({ length: 255 }).notNull(),
    channelName: varchar({ length: 255 }).notNull(),

    // if points and voiceTime were awarded for this session
    isTracked: boolean().default(false).notNull(),

    // in seconds
    duration: integer().generatedAlwaysAs(sql`EXTRACT(EPOCH FROM (left_at - joined_at))`),
  },
  (table) => [index("voice_session_discord_id_left_at_idx").on(table.discordId, table.leftAt)],
);

// Holds submission data so approvals/rejections persist bot restarts
export const submissionTable = pgTable("submission", {
  // Technical fields
  id: serial().primaryKey(),
  discordId: varchar({ length: 255 })
    .notNull()
    .references(() => userTable.discordId),
  submittedAt: timestamp().notNull().defaultNow(),
  reviewedAt: timestamp(),
  reviewedBy: varchar({ length: 255 }),

  // Submission fields
  house: varchar({
    length: 50,
    enum: ["Gryffindor", "Hufflepuff", "Ravenclaw", "Slytherin"],
  }).notNull(),
  houseId: integer().default(-1).notNull(),
  screenshotUrl: varchar({ length: 1000 }).notNull(),
  points: integer().notNull(),
  status: varchar({
    length: 50,
    enum: ["PENDING", "APPROVED", "REJECTED"],
  })
    .default("PENDING")
    .notNull(),
});

// Holds message ids to be updated for house scoreboards
export const houseScoreboardTable = pgTable("house_scoreboard", {
  id: serial().primaryKey(),
  house: varchar({
    length: 50,
    enum: ["Gryffindor", "Hufflepuff", "Ravenclaw", "Slytherin"],
  }).notNull(),
  channelId: text().notNull(),
  messageId: text().notNull(),
  updatedAt: timestamp().defaultNow().notNull(),
});
