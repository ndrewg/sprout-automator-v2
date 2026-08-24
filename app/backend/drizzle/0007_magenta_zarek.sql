ALTER TABLE "runs" ADD COLUMN "attempt" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "retry_intro_shown" boolean DEFAULT false NOT NULL;