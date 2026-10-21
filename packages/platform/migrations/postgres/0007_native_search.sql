-- The native search index. `tsv` is written by the adapter from its own normalised terms (weight A for the name, B
-- for SKUs and variant names, C for the description) rather than by to_tsvector, whose parser splits some ASCII runs
-- (`1e5x` becomes `1e5` and `x`) where the adapter's tokeniser keeps one term.
CREATE TABLE IF NOT EXISTS "search_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"fields" jsonb NOT NULL,
	"category_ids" text[] DEFAULT '{}' NOT NULL,
	"tsv" tsvector NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "search_documents_tsv_idx" ON "search_documents" USING gin ("tsv");
