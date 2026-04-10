CREATE INDEX "point_adjustment_discord_id_created_at_idx" ON "point_adjustment" USING btree ("discord_id");--> statement-breakpoint
CREATE INDEX "submission_discordId_status_submitted_at_idx" ON "submission" USING btree ("discord_id","status","submitted_at");--> statement-breakpoint
CREATE INDEX "submission_house_submitted_at_idx" ON "submission" USING btree ("house","submitted_at");--> statement-breakpoint
CREATE INDEX "user_house_monthly_points_idx" ON "user" USING btree ("house","monthly_points" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "house_cup_month" ADD CONSTRAINT "house_cup_month_month_unique" UNIQUE("month");--> statement-breakpoint
ALTER TABLE "submission" ADD CONSTRAINT "submission_messageId_unique" UNIQUE("message_id");