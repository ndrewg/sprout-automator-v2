CREATE TABLE "gazette_holidays" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"manila_date" text NOT NULL,
	"name" text NOT NULL,
	"scope" text NOT NULL,
	"proclamation_no" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "gazette_holiday_date_name" ON "gazette_holidays" USING btree ("manila_date","name");--> statement-breakpoint
CREATE INDEX "gazette_holiday_date_idx" ON "gazette_holidays" USING btree ("manila_date");