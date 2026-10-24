ALTER TABLE "orders" ADD COLUMN "cart_token" text;--> statement-breakpoint
-- The cart moves out of free-form metadata. Of several pending orders on one cart (made before this guard existed) only
-- the newest takes the token, so the index below can be built; the older ones stay as they are, without one.
UPDATE "orders" SET "cart_token" = "metadata"->>'cartToken'
WHERE jsonb_typeof("metadata"->'cartToken') = 'string' AND (
	"status" <> 'pending' OR NOT EXISTS (
		SELECT 1 FROM "orders" AS "newer"
		WHERE "newer"."status" = 'pending' AND "newer"."sequence" > "orders"."sequence"
			AND "newer"."metadata"->>'cartToken' = "orders"."metadata"->>'cartToken'
	)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "orders_pending_cart_unique" ON "orders" USING btree ("cart_token") WHERE status = 'pending';
