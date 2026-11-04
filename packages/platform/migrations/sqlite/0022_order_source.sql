ALTER TABLE `carts` ADD `source` text DEFAULT 'storefront' NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `source` text DEFAULT 'storefront' NOT NULL;--> statement-breakpoint
CREATE INDEX `orders_source_created_idx` ON `orders` (`source`,`created_at`);