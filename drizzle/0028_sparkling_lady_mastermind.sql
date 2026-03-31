CREATE TABLE "journal_entry" (
	"id" serial PRIMARY KEY NOT NULL,
	"date" date NOT NULL,
	"prompt" text NOT NULL,
	"message_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "journal_entry_date_idx" ON "journal_entry" USING btree ("date");