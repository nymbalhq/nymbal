-- Every key gets an expiry. A migration reads no config, so existing rows get the default lifetimes: 48 hours for a
-- checkout key, 30 days for an email key. The value is ISO UTC text, as the repository writes `created_at`: a bare
-- `datetime()` would read back as local time. SQLite cannot add a NOT NULL column without a default, so the table
-- is rebuilt.
CREATE TABLE `__new_order_access_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`key_hash` text NOT NULL,
	`purpose` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_order_access_keys` (`id`, `order_id`, `key_hash`, `purpose`, `created_at`, `expires_at`)
SELECT `id`, `order_id`, `key_hash`, `purpose`, `created_at`,
	strftime('%Y-%m-%dT%H:%M:%fZ', `created_at`, CASE `purpose` WHEN 'email' THEN '+30 days' ELSE '+48 hours' END)
FROM `order_access_keys`;
--> statement-breakpoint
DROP TABLE `order_access_keys`;
--> statement-breakpoint
ALTER TABLE `__new_order_access_keys` RENAME TO `order_access_keys`;
--> statement-breakpoint
CREATE UNIQUE INDEX `order_access_keys_key_hash_idx` ON `order_access_keys` (`key_hash`);
--> statement-breakpoint
CREATE INDEX `order_access_keys_order_idx` ON `order_access_keys` (`order_id`);
