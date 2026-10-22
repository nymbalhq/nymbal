CREATE TABLE `settings` (
	`slot` text NOT NULL,
	`path` text NOT NULL,
	`ciphertext` blob,
	`plain` text,
	`iv` blob,
	`tag` blob,
	`key_id` text,
	`updated_at` text NOT NULL,
	`updated_by` text,
	PRIMARY KEY(`slot`, `path`),
	CONSTRAINT "settings_one_value" CHECK(("settings"."ciphertext" IS NULL) <> ("settings"."plain" IS NULL) AND ("settings"."ciphertext" IS NULL OR ("settings"."iv" IS NOT NULL AND "settings"."tag" IS NOT NULL AND "settings"."key_id" IS NOT NULL)))
);
