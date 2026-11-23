ALTER TABLE "refresh_tokens" ADD COLUMN "session_id" text;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD COLUMN "session_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD COLUMN "device" text;