-- The correlation id as a column, so one operation's events are an index range. SQLite adds a NOT NULL column only
-- with a default; a table rebuild instead would reset the AUTOINCREMENT high-water mark when retention has deleted the
-- newest rows, and reuse their seqs. Every existing row is backfilled from its envelope, else its own id (the builder's
-- default), so no row keeps the placeholder.
ALTER TABLE `events` ADD `correlation_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE `events` SET `correlation_id` = COALESCE(json_extract(`envelope`, '$.correlationId'), `id`);--> statement-breakpoint
CREATE INDEX `events_correlation_idx` ON `events` (`correlation_id`,`seq`);
