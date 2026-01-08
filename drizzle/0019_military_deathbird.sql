ALTER TABLE "submission" DROP CONSTRAINT "submission_discord_id_user_discord_id_fk";
--> statement-breakpoint
ALTER TABLE "voice_session" DROP CONSTRAINT "voice_session_discord_id_user_discord_id_fk";
--> statement-breakpoint
ALTER TABLE "submission" ADD CONSTRAINT "submission_discord_id_user_discord_id_fk" FOREIGN KEY ("discord_id") REFERENCES "public"."user"("discord_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_session" ADD CONSTRAINT "voice_session_discord_id_user_discord_id_fk" FOREIGN KEY ("discord_id") REFERENCES "public"."user"("discord_id") ON DELETE cascade ON UPDATE no action;