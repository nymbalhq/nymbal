CREATE TABLE `promotion_redemptions` (
	`promotion_id` text NOT NULL,
	`order_id` text NOT NULL,
	`session_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`promotion_id`, `order_id`)
);
--> statement-breakpoint
CREATE TABLE `promotions` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`kind` text NOT NULL,
	`percent_bps` integer,
	`amount_off_minor` integer,
	`currency` text,
	`minimum_subtotal_minor` integer,
	`expires_at` text,
	`usage_cap` integer,
	`active` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `promotions_code_lower_unique` ON `promotions` (lower("code"));--> statement-breakpoint
CREATE INDEX `promotions_created_idx` ON `promotions` (`created_at`);--> statement-breakpoint
ALTER TABLE `carts` ADD `promotions` text;