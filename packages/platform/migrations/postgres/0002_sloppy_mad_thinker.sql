CREATE TABLE IF NOT EXISTS "events" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"id" text NOT NULL,
	"type" text NOT NULL,
	"envelope" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"delivered_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"dead_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "processed_events" (
	"handler_name" text NOT NULL,
	"event_id" text NOT NULL,
	"processed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "processed_events_handler_name_event_id_pk" PRIMARY KEY("handler_name","event_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "events_id_unique" ON "events" USING btree ("id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_undelivered_idx" ON "events" USING btree ("delivered_at","seq");