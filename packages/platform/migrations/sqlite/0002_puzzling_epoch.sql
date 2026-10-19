CREATE TABLE `events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`type` text NOT NULL,
	`envelope` text NOT NULL,
	`created_at` text NOT NULL,
	`delivered_at` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`dead_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_id_unique` ON `events` (`id`);--> statement-breakpoint
CREATE INDEX `events_undelivered_idx` ON `events` (`delivered_at`,`seq`);--> statement-breakpoint
CREATE TABLE `processed_events` (
	`handler_name` text NOT NULL,
	`event_id` text NOT NULL,
	`processed_at` text NOT NULL,
	PRIMARY KEY(`handler_name`, `event_id`)
);
