CREATE TYPE "public"."house" AS ENUM('Gryffindor', 'Hufflepuff', 'Ravenclaw', 'Slytherin');--> statement-breakpoint
CREATE TYPE "public"."submission_status" AS ENUM('PENDING', 'APPROVED', 'REJECTED', 'CANCELED');--> statement-breakpoint
CREATE TYPE "public"."submission_type" AS ENUM('NEW', 'COMPLETED');--> statement-breakpoint
ALTER TABLE "house_cup_entry" ALTER COLUMN "house" SET DATA TYPE "public"."house" USING "house"::"public"."house";--> statement-breakpoint
ALTER TABLE "house_cup_month" ALTER COLUMN "winner" SET DATA TYPE "public"."house" USING "winner"::"public"."house";--> statement-breakpoint
ALTER TABLE "house_scoreboard" ALTER COLUMN "house" SET DATA TYPE "public"."house" USING "house"::"public"."house";--> statement-breakpoint
ALTER TABLE "submission" ALTER COLUMN "house" SET DATA TYPE "public"."house" USING "house"::"public"."house";--> statement-breakpoint
ALTER TABLE "submission" ALTER COLUMN "submission_type" SET DATA TYPE "public"."submission_type" USING "submission_type"::"public"."submission_type";--> statement-breakpoint
ALTER TABLE "submission" ALTER COLUMN "status" SET DEFAULT 'PENDING'::"public"."submission_status";--> statement-breakpoint
ALTER TABLE "submission" ALTER COLUMN "status" SET DATA TYPE "public"."submission_status" USING "status"::"public"."submission_status";--> statement-breakpoint
ALTER TABLE "user" ALTER COLUMN "house" SET DATA TYPE "public"."house" USING "house"::"public"."house";