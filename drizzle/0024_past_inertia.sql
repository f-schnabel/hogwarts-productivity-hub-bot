-- Undo streak increments that already happened today via the old messageCreate logic,
-- so the new daily-reset-based increment doesn't double-count them.
UPDATE "user" SET message_streak = message_streak - 1 WHERE is_message_streak_updated_today = true AND message_streak > 0;
ALTER TABLE "user" DROP COLUMN "is_message_streak_updated_today";