CREATE TABLE `order_tax_documents` (
	`order_id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`document_id` text,
	`committed_at` text,
	`refunded_minor` integer DEFAULT 0 NOT NULL,
	`filed_refund_ids` text DEFAULT '[]' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`due_since` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `order_tax_documents_due_since_idx` ON `order_tax_documents` (`due_since`);