CREATE TABLE `order_shipments` (
	`order_id` text PRIMARY KEY NOT NULL,
	`carrier` text NOT NULL,
	`tracking_number` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `order_shipments_tracking_number_idx` ON `order_shipments` (`tracking_number`);