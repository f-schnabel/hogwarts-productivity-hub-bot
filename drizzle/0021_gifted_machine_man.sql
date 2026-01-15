CREATE TABLE "point_adjustment" (
	"id" serial PRIMARY KEY NOT NULL,
	"discord_id" varchar(255) NOT NULL,
	"adjusted_by" varchar(255) NOT NULL,
	"amount" integer NOT NULL,
	"reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "point_adjustment" ADD CONSTRAINT "point_adjustment_discord_id_user_discord_id_fk" FOREIGN KEY ("discord_id") REFERENCES "public"."user"("discord_id") ON DELETE cascade ON UPDATE no action;