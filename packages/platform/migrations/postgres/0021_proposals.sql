CREATE TABLE "proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"tool" text NOT NULL,
	"command" text NOT NULL,
	"args" jsonb NOT NULL,
	"handles" jsonb,
	"idempotency_key" text,
	"proposer_id" text,
	"agent_name" text NOT NULL,
	"agent_version" text,
	"correlation_id" text NOT NULL,
	"status" text NOT NULL,
	"decided_by_kind" text,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"reason" text,
	"outcome_status" integer,
	"outcome_code" text,
	"outcome_message" text,
	"created_at" timestamp with time zone NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "proposals_status" CHECK ("proposals"."status" IN ('pending', 'approved', 'rejected', 'applied', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "proposals_key_unique" ON "proposals" USING btree ("proposer_id","tool","idempotency_key") WHERE "proposals"."proposer_id" IS NOT NULL AND "proposals"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "proposals_created_idx" ON "proposals" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "proposals_status_idx" ON "proposals" USING btree ("status","created_at","id");