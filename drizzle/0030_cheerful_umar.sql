CREATE TABLE "guild_config" (
	"guild_id" varchar(255) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"prefect_role_id" text,
	"professor_role_id" text,
	"vc_role_id" text,
	"gryffindor_role_id" text,
	"slytherin_role_id" text,
	"hufflepuff_role_id" text,
	"ravenclaw_role_id" text,
	"year_role_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"year_announcement_channel_id" text,
	"journal_channel_id" text,
	"counting_channel_id" text,
	"gringotts_channel_id" text,
	"submission_channel_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"exclude_voice_channel_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"vc_emoji" text,
	"gryffindor_crest_emoji_id" text,
	"slytherin_crest_emoji_id" text,
	"hufflepuff_crest_emoji_id" text,
	"ravenclaw_crest_emoji_id" text
);
--> statement-breakpoint
CREATE TABLE "guild_state" (
	"guild_id" varchar(255) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"last_monthly_reset" timestamp,
	"counting_count" integer DEFAULT 0 NOT NULL,
	"counting_discord_id" text
);
