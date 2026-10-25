-- What opens an order to a shopper with no session: the sha256 hex of each key a checkout or an email served.
CREATE TABLE `order_access_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`key_hash` text NOT NULL,
	`purpose` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `order_access_keys_key_hash_idx` ON `order_access_keys` (`key_hash`);--> statement-breakpoint
CREATE INDEX `order_access_keys_order_idx` ON `order_access_keys` (`order_id`);
