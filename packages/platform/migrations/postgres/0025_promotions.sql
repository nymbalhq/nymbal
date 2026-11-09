CREATE TABLE "promotion_redemptions" (
	"promotion_id" text NOT NULL,
	"order_id" text NOT NULL,
	"session_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "promotion_redemptions_promotion_id_order_id_pk" PRIMARY KEY("promotion_id","order_id")
);
--> statement-breakpoint
CREATE TABLE "promotions" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"kind" text NOT NULL,
	"percent_bps" integer,
	"amount_off_minor" integer,
	"currency" text,
	"minimum_subtotal_minor" integer,
	"expires_at" timestamp with time zone,
	"usage_cap" integer,
	"active" boolean NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "carts" ADD COLUMN "promotions" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "promotions_code_lower_unique" ON "promotions" USING btree (lower("code"));--> statement-breakpoint
CREATE INDEX "promotions_created_idx" ON "promotions" USING btree ("created_at");