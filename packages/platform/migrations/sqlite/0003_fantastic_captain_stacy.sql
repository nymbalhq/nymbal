CREATE TABLE `carts` (
	`token` text PRIMARY KEY NOT NULL,
	`customer_id` text,
	`currency` text NOT NULL,
	`items` text DEFAULT '[]' NOT NULL,
	`line_count` integer DEFAULT 0 NOT NULL,
	`subtotal_minor` integer DEFAULT 0 NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`abandoned_notified_at` text
);
--> statement-breakpoint
CREATE INDEX `carts_expires_idx` ON `carts` (`expires_at`);--> statement-breakpoint
CREATE INDEX `carts_updated_idx` ON `carts` (`updated_at`);