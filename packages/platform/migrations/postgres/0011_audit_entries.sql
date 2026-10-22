-- Append-only: rows are written once, in the command's transaction, and never updated, deleted or pruned.
CREATE TABLE IF NOT EXISTS "audit_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_id" text NOT NULL,
	"command" text NOT NULL,
	"subjects" jsonb NOT NULL,
	"correlation_id" text,
	"idempotency_key" text,
	"request_hash" text,
	"outcome" text NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	CONSTRAINT "audit_entries_outcome" CHECK ("audit_entries"."outcome" IN ('applied', 'refused', 'replayed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "audit_entries_applied_key_unique" ON "audit_entries" USING btree ("actor_id","command","idempotency_key") WHERE "audit_entries"."outcome" = 'applied' AND "audit_entries"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_entries_at_idx" ON "audit_entries" USING btree ("at","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_entries_correlation_idx" ON "audit_entries" USING btree ("correlation_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION "audit_entries_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_entries is append-only';
END
$$;--> statement-breakpoint
CREATE TRIGGER "audit_entries_append_only" BEFORE UPDATE OR DELETE ON "audit_entries"
  FOR EACH ROW EXECUTE FUNCTION "audit_entries_append_only"();
