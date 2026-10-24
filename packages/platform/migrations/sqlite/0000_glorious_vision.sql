CREATE TABLE `categories` (
	`id` text PRIMARY KEY NOT NULL,
	`parent_id` text,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `categories_slug_unique` ON `categories` (`slug`);--> statement-breakpoint
CREATE INDEX `categories_parent_idx` ON `categories` (`parent_id`);--> statement-breakpoint
CREATE TABLE `customers` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`password_hash` text NOT NULL,
	`first_name` text DEFAULT '' NOT NULL,
	`last_name` text DEFAULT '' NOT NULL,
	`phone` text DEFAULT '' NOT NULL,
	`addresses` text DEFAULT '[]' NOT NULL,
	`order_count` integer DEFAULT 0 NOT NULL,
	`total_spent_minor` integer DEFAULT 0 NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`requires_password_reset` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `customers_email_unique` ON `customers` (`email`);--> statement-breakpoint
CREATE TABLE `inventory_reservations` (
	`reservation_id` text PRIMARY KEY NOT NULL,
	`variant_id` text NOT NULL,
	`qty` integer NOT NULL,
	`order_ref` text,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `inv_reservations_variant_idx` ON `inventory_reservations` (`variant_id`);--> statement-breakpoint
CREATE INDEX `inv_reservations_expires_idx` ON `inventory_reservations` (`expires_at`);--> statement-breakpoint
CREATE TABLE `order_history` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`from_status` text,
	`to_status` text NOT NULL,
	`actor` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`timestamp` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `order_history_order_idx` ON `order_history` (`order_id`);--> statement-breakpoint
CREATE TABLE `order_sequences` (
	`id` integer PRIMARY KEY NOT NULL,
	`next_value` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `orders` (
	`id` text PRIMARY KEY NOT NULL,
	`order_number` text NOT NULL,
	`sequence` integer NOT NULL,
	`customer_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`email` text NOT NULL,
	`billing_address` text NOT NULL,
	`shipping_address` text NOT NULL,
	`line_items` text NOT NULL,
	`subtotal_minor` integer NOT NULL,
	`tax_total_minor` integer DEFAULT 0 NOT NULL,
	`shipping_total_minor` integer DEFAULT 0 NOT NULL,
	`discount_total_minor` integer DEFAULT 0 NOT NULL,
	`total_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`payment_intent_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `orders_number_unique` ON `orders` (`order_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `orders_sequence_unique` ON `orders` (`sequence`);--> statement-breakpoint
CREATE INDEX `orders_customer_idx` ON `orders` (`customer_id`);--> statement-breakpoint
CREATE INDEX `orders_status_idx` ON `orders` (`status`);--> statement-breakpoint
CREATE TABLE `product_categories` (
	`product_id` text NOT NULL,
	`category_id` text NOT NULL,
	PRIMARY KEY(`product_id`, `category_id`)
);
--> statement-breakpoint
CREATE INDEX `product_categories_category_idx` ON `product_categories` (`category_id`);--> statement-breakpoint
CREATE TABLE `products` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`short_description` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`type` text DEFAULT 'simple' NOT NULL,
	`seo_title` text DEFAULT '' NOT NULL,
	`seo_description` text DEFAULT '' NOT NULL,
	`media` text DEFAULT '[]' NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `products_slug_unique` ON `products` (`slug`);--> statement-breakpoint
CREATE INDEX `products_status_idx` ON `products` (`status`);--> statement-breakpoint
CREATE TABLE `refresh_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`revoked_at` text,
	`replaced_by_jti` text,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `refresh_tokens_customer_idx` ON `refresh_tokens` (`customer_id`);--> statement-breakpoint
CREATE TABLE `reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`customer_id` text,
	`order_id` text,
	`rating` integer NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`moderation_status` text DEFAULT 'pending' NOT NULL,
	`submitted_at` text NOT NULL,
	`moderated_at` text,
	`moderated_by` text
);
--> statement-breakpoint
CREATE INDEX `reviews_product_idx` ON `reviews` (`product_id`);--> statement-breakpoint
CREATE INDEX `reviews_status_idx` ON `reviews` (`moderation_status`);--> statement-breakpoint
CREATE TABLE `stock_adjustments` (
	`id` text PRIMARY KEY NOT NULL,
	`variant_id` text NOT NULL,
	`adjustment` integer NOT NULL,
	`reason` text NOT NULL,
	`actor` text NOT NULL,
	`previous_qty` integer NOT NULL,
	`new_qty` integer NOT NULL,
	`timestamp` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `stock_adjustments_variant_idx` ON `stock_adjustments` (`variant_id`);--> statement-breakpoint
CREATE TABLE `variants` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`sku` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`price_minor` integer NOT NULL,
	`compare_at_price_minor` integer,
	`weight_grams` integer,
	`dimensions` text,
	`stock` integer DEFAULT 0 NOT NULL,
	`low_stock_threshold` integer DEFAULT 0 NOT NULL,
	`options` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `variants_sku_unique` ON `variants` (`sku`);--> statement-breakpoint
CREATE INDEX `variants_product_idx` ON `variants` (`product_id`);