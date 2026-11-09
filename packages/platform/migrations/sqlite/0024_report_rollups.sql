CREATE TABLE `report_funnel_days` (
	`local_day` text NOT NULL,
	`source` text NOT NULL,
	`timezone` text NOT NULL,
	`viewers` integer DEFAULT 0 NOT NULL,
	`carts_with_items` integer DEFAULT 0 NOT NULL,
	`checkouts_started` integer DEFAULT 0 NOT NULL,
	`payments_failed` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`local_day`, `source`)
);
--> statement-breakpoint
CREATE TABLE `report_members` (
	`kind` text NOT NULL,
	`local_day` text NOT NULL,
	`member` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`kind`, `local_day`, `member`)
);
--> statement-breakpoint
CREATE TABLE `report_product_days` (
	`local_day` text NOT NULL,
	`variant_id` text NOT NULL,
	`currency` text NOT NULL,
	`source` text NOT NULL,
	`timezone` text NOT NULL,
	`product_id` text NOT NULL,
	`product_name` text NOT NULL,
	`variant_name` text NOT NULL,
	`sku` text NOT NULL,
	`units` integer DEFAULT 0 NOT NULL,
	`line_subtotal_minor` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`local_day`, `variant_id`, `currency`, `source`)
);
--> statement-breakpoint
CREATE TABLE `report_sales_hours` (
	`hour_start` text NOT NULL,
	`local_day` text NOT NULL,
	`timezone` text NOT NULL,
	`currency` text NOT NULL,
	`source` text NOT NULL,
	`captured_minor` integer DEFAULT 0 NOT NULL,
	`refunded_minor` integer DEFAULT 0 NOT NULL,
	`paid_orders` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`hour_start`, `currency`, `source`)
);
--> statement-breakpoint
CREATE INDEX `report_sales_hours_local_day_idx` ON `report_sales_hours` (`local_day`);--> statement-breakpoint
CREATE TABLE `report_search_days` (
	`local_day` text NOT NULL,
	`term` text NOT NULL,
	`timezone` text NOT NULL,
	`searches` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`local_day`, `term`)
);
