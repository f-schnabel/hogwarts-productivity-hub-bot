CREATE TABLE "house_cup_entry" (
	"id" serial PRIMARY KEY NOT NULL,
	"month_id" integer NOT NULL,
	"house" varchar(50) NOT NULL,
	"weighted_points" integer NOT NULL,
	"raw_points" integer NOT NULL,
	"member_count" integer NOT NULL,
	"qualifying_count" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "house_cup_month" (
	"id" serial PRIMARY KEY NOT NULL,
	"month" varchar(7) NOT NULL,
	"winner" varchar(50) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "house_cup_entry" ADD CONSTRAINT "house_cup_entry_month_id_house_cup_month_id_fk" FOREIGN KEY ("month_id") REFERENCES "public"."house_cup_month"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "house_cup_entry_month_id_idx" ON "house_cup_entry" USING btree ("month_id");