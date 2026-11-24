CREATE TABLE "order_tax_documents" (
	"order_id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"document_id" text,
	"committed_at" timestamp with time zone,
	"refunded_minor" integer DEFAULT 0 NOT NULL,
	"filed_refund_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"due_since" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "order_tax_documents_due_since_idx" ON "order_tax_documents" USING btree ("due_since");