CREATE TABLE `email_suppressions` (
	`email` text PRIMARY KEY NOT NULL,
	`reason` text NOT NULL,
	`event_id` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "email_suppressions_reason" CHECK("email_suppressions"."reason" IN ('hard_bounce', 'complaint'))
);
