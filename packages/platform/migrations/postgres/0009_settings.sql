CREATE TABLE IF NOT EXISTS "settings" (
	"slot" text NOT NULL,
	"path" text NOT NULL,
	"ciphertext" "bytea",
	"plain" text,
	"iv" "bytea",
	"tag" "bytea",
	"key_id" text,
	"updated_at" timestamp with time zone NOT NULL,
	"updated_by" text,
	CONSTRAINT "settings_slot_path_pk" PRIMARY KEY("slot","path"),
	CONSTRAINT "settings_one_value" CHECK (("settings"."ciphertext" IS NULL) <> ("settings"."plain" IS NULL) AND ("settings"."ciphertext" IS NULL OR ("settings"."iv" IS NOT NULL AND "settings"."tag" IS NOT NULL AND "settings"."key_id" IS NOT NULL)))
);
