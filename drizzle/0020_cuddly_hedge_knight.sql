ALTER TABLE "user" ADD COLUMN "announced_year" integer DEFAULT 0 NOT NULL;

-- Backfill: calculate year from monthly_voice_time for existing users
-- Thresholds: 1h=3600s, 10h=36000s, 20h=72000s, 40h=144000s, 80h=288000s, 100h=360000s, 120h=432000s
UPDATE "user" SET "announced_year" = CASE
  WHEN monthly_voice_time >= 432000 THEN 7
  WHEN monthly_voice_time >= 360000 THEN 6
  WHEN monthly_voice_time >= 288000 THEN 5
  WHEN monthly_voice_time >= 144000 THEN 4
  WHEN monthly_voice_time >= 72000 THEN 3
  WHEN monthly_voice_time >= 36000 THEN 2
  WHEN monthly_voice_time >= 3600 THEN 1
  ELSE 0
END;