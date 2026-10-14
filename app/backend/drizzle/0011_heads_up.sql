CREATE TABLE "heads_up_notices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"manila_date" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN "notify_heads_up" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "heads_up_notices" ADD CONSTRAINT "heads_up_notices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "heads_up_notice_once" ON "heads_up_notices" USING btree ("user_id","manila_date");