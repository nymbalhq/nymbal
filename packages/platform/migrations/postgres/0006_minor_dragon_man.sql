CREATE TABLE IF NOT EXISTS "order_refunds" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency" text NOT NULL,
	"provider_refund_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"actor" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"request_id" text
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "captured_minor" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "captured_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "refunded_minor" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "capture_method" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_refunds_order_idx" ON "order_refunds" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "order_refunds_order_request_idx" ON "order_refunds" USING btree ("order_id","request_id");--> statement-breakpoint
-- Orders taken before captures were recorded: one confirmed or later (and not cancelled) was paid in full when it last
-- changed; with an intent the provider took it, without one it came from an import. A partially_refunded order keeps
-- refunded_minor 0: what it refunded was never stored, and there is no production data from before this migration.
UPDATE "orders"
SET "captured_minor" = "total_minor",
	"captured_at" = "updated_at",
	"capture_method" = CASE WHEN "payment_intent_id" IS NULL THEN 'import' ELSE 'provider' END
WHERE "status" IN ('confirmed', 'processing', 'shipped', 'delivered', 'refunded', 'partially_refunded');--> statement-breakpoint
UPDATE "orders" SET "refunded_minor" = "captured_minor" WHERE "status" = 'refunded';
