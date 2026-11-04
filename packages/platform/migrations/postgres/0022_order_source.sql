ALTER TABLE "carts" ADD COLUMN "source" text DEFAULT 'storefront' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "source" text COLLATE "C" DEFAULT 'storefront' NOT NULL;--> statement-breakpoint
CREATE INDEX "orders_source_created_idx" ON "orders" USING btree ("source","created_at");