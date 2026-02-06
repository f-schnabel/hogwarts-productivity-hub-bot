ALTER TABLE "submission" ADD COLUMN "message_id" varchar(255);--> statement-breakpoint
ALTER TABLE "submission" ADD COLUMN "channel_id" varchar(255);--> statement-breakpoint
ALTER TABLE "submission" ADD COLUMN "linked_submission_id" integer;