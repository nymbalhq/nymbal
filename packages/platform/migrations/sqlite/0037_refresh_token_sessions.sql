ALTER TABLE `refresh_tokens` ADD `session_id` text;--> statement-breakpoint
ALTER TABLE `refresh_tokens` ADD `session_started_at` text;--> statement-breakpoint
ALTER TABLE `refresh_tokens` ADD `device` text;