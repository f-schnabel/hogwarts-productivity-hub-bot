CREATE TABLE "pomodoro_session" (
	"id" serial PRIMARY KEY NOT NULL,
	"channel_id" varchar(255) NOT NULL,
	"channel_name" varchar(255) NOT NULL,
	"focus_minutes" integer NOT NULL,
	"break_minutes" integer NOT NULL,
	"stage" varchar(10) NOT NULL,
	"stage_started_at" timestamp DEFAULT now() NOT NULL,
	"next_stage_at" timestamp NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"ended_at" timestamp,
	"status_message_id" varchar(255)
);
--> statement-breakpoint
ALTER TABLE "voice_session" ADD COLUMN "credited_duration" integer;--> statement-breakpoint
CREATE INDEX "pomodoro_session_channel_id_ended_at_idx" ON "pomodoro_session" USING btree ("channel_id","ended_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pomodoro_session_status_message_id_idx" ON "pomodoro_session" USING btree ("status_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pomodoro_session_active_channel_id_idx" ON "pomodoro_session" USING btree ("channel_id") WHERE "pomodoro_session"."ended_at" IS NULL;