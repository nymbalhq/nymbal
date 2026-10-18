CREATE TABLE IF NOT EXISTS "carts" (
	"token" text PRIMARY KEY NOT NULL,
	"customer_id" text,
	"currency" text NOT NULL,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"line_count" integer DEFAULT 0 NOT NULL,
	"subtotal_minor" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"abandoned_notified_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "carts_expires_idx" ON "carts" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "carts_updated_idx" ON "carts" USING btree ("updated_at");