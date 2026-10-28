-- What opens an order to a shopper with no session: the sha256 hex of each key a checkout or an email served.
CREATE TABLE IF NOT EXISTS "order_access_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"key_hash" text NOT NULL,
	"purpose" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "order_access_keys_key_hash_idx" ON "order_access_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_access_keys_order_idx" ON "order_access_keys" USING btree ("order_id");
