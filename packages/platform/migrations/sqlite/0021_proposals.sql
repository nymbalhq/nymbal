CREATE TABLE `proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`tool` text NOT NULL,
	`command` text NOT NULL,
	`args` text NOT NULL,
	`handles` text,
	`idempotency_key` text,
	`proposer_id` text,
	`agent_name` text NOT NULL,
	`agent_version` text,
	`correlation_id` text NOT NULL,
	`status` text NOT NULL,
	`decided_by_kind` text,
	`decided_by` text,
	`decided_at` text,
	`reason` text,
	`outcome_status` integer,
	`outcome_code` text,
	`outcome_message` text,
	`created_at` text NOT NULL,
	`settled_at` text,
	CONSTRAINT "proposals_status" CHECK("proposals"."status" IN ('pending', 'approved', 'rejected', 'applied', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `proposals_key_unique` ON `proposals` (`proposer_id`,`tool`,`idempotency_key`) WHERE "proposals"."proposer_id" IS NOT NULL AND "proposals"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `proposals_created_idx` ON `proposals` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `proposals_status_idx` ON `proposals` (`status`,`created_at`,`id`);