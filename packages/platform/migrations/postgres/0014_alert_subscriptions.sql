CREATE TABLE IF NOT EXISTS "alert_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"kind" text NOT NULL,
	"variant_id" text NOT NULL,
	"product_id" text NOT NULL,
	"status" text NOT NULL,
	"confirm_token" text NOT NULL,
	"unsubscribe_token" text NOT NULL,
	"origin" text NOT NULL,
	"baseline_price_minor" integer,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"confirmed_at" timestamp with time zone,
	CONSTRAINT "alert_subscriptions_kind" CHECK ("alert_subscriptions"."kind" IN ('back_in_stock', 'price_drop')),
	CONSTRAINT "alert_subscriptions_status" CHECK ("alert_subscriptions"."status" IN ('pending', 'active', 'fired', 'unsubscribed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "alert_subscriptions_address_unique" ON "alert_subscriptions" USING btree ("email","variant_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "alert_subscriptions_confirm_token_unique" ON "alert_subscriptions" USING btree ("confirm_token");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "alert_subscriptions_unsubscribe_token_unique" ON "alert_subscriptions" USING btree ("unsubscribe_token");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "alert_subscriptions_fan_out_idx" ON "alert_subscriptions" USING btree ("variant_id","kind","status");