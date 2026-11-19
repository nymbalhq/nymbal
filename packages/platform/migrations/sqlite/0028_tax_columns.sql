ALTER TABLE `orders` ADD `prices_include_tax` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `products` ADD `tax_code` text;--> statement-breakpoint
ALTER TABLE `variants` ADD `tax_code` text;