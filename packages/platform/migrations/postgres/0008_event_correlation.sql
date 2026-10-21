-- The correlation id as a column, so one operation's events are an index range. Every existing row is backfilled from
-- its envelope, else its own id (the builder's default), before the column becomes NOT NULL.
ALTER TABLE "events" ADD COLUMN "correlation_id" text;--> statement-breakpoint
UPDATE "events" SET "correlation_id" = COALESCE("envelope"->>'correlationId', "id");--> statement-breakpoint
ALTER TABLE "events" ALTER COLUMN "correlation_id" SET NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_correlation_idx" ON "events" USING btree ("correlation_id","seq");
