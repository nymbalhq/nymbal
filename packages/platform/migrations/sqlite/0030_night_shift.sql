CREATE TABLE `insights` (
	`id` text PRIMARY KEY NOT NULL,
	`job` text NOT NULL,
	`subject` text NOT NULL,
	`run_day` text NOT NULL,
	`data_day` text NOT NULL,
	`status` text NOT NULL,
	`severity` text NOT NULL,
	`summary` text NOT NULL,
	`facts` text NOT NULL,
	`created_at` text NOT NULL,
	`dismissed_at` text,
	CONSTRAINT "insights_status" CHECK("insights"."status" IN ('open', 'dismissed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `insights_key_unique` ON `insights` (`job`,`subject`,`run_day`);--> statement-breakpoint
CREATE INDEX `insights_subject_idx` ON `insights` (`job`,`subject`,`status`);--> statement-breakpoint
CREATE TABLE `night_shift_runs` (
	`job` text NOT NULL,
	`run_day` text NOT NULL,
	`status` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`insights` integer DEFAULT 0 NOT NULL,
	`error` text,
	PRIMARY KEY(`job`, `run_day`),
	CONSTRAINT "night_shift_runs_status" CHECK("night_shift_runs"."status" IN ('running', 'done', 'failed'))
);
