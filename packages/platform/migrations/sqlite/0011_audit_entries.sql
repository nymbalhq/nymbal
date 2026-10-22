-- Append-only: rows are written once, in the command's transaction, and never updated, deleted or pruned.
CREATE TABLE `audit_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`at` text NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_id` text NOT NULL,
	`command` text NOT NULL,
	`subjects` text NOT NULL,
	`correlation_id` text,
	`idempotency_key` text,
	`request_hash` text,
	`outcome` text NOT NULL,
	`response_status` integer,
	`response_body` text,
	CONSTRAINT "audit_entries_outcome" CHECK("audit_entries"."outcome" IN ('applied', 'refused', 'replayed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `audit_entries_applied_key_unique` ON `audit_entries` (`actor_id`,`command`,`idempotency_key`) WHERE "audit_entries"."outcome" = 'applied' AND "audit_entries"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `audit_entries_at_idx` ON `audit_entries` (`at`,`id`);--> statement-breakpoint
CREATE INDEX `audit_entries_correlation_idx` ON `audit_entries` (`correlation_id`);--> statement-breakpoint
CREATE TRIGGER `audit_entries_no_update` BEFORE UPDATE ON `audit_entries` BEGIN
  SELECT RAISE(ABORT, 'audit_entries is append-only');
END;--> statement-breakpoint
CREATE TRIGGER `audit_entries_no_delete` BEFORE DELETE ON `audit_entries` BEGIN
  SELECT RAISE(ABORT, 'audit_entries is append-only');
END;
