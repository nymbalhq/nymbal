CREATE TABLE "report_funnel_days" (
	"local_day" text NOT NULL,
	"source" text NOT NULL,
	"timezone" text NOT NULL,
	"viewers" bigint DEFAULT 0 NOT NULL,
	"carts_with_items" bigint DEFAULT 0 NOT NULL,
	"checkouts_started" bigint DEFAULT 0 NOT NULL,
	"payments_failed" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "report_funnel_days_local_day_source_pk" PRIMARY KEY("local_day","source")
);
--> statement-breakpoint
CREATE TABLE "report_members" (
	"kind" text NOT NULL,
	"local_day" text NOT NULL,
	"member" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "report_members_kind_local_day_member_pk" PRIMARY KEY("kind","local_day","member")
);
--> statement-breakpoint
CREATE TABLE "report_product_days" (
	"local_day" text NOT NULL,
	"variant_id" text NOT NULL,
	"currency" text NOT NULL,
	"source" text NOT NULL,
	"timezone" text NOT NULL,
	"product_id" text NOT NULL,
	"product_name" text NOT NULL,
	"variant_name" text NOT NULL,
	"sku" text NOT NULL,
	"units" bigint DEFAULT 0 NOT NULL,
	"line_subtotal_minor" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "report_product_days_local_day_variant_id_currency_source_pk" PRIMARY KEY("local_day","variant_id","currency","source")
);
--> statement-breakpoint
CREATE TABLE "report_sales_hours" (
	"hour_start" timestamp with time zone NOT NULL,
	"local_day" text NOT NULL,
	"timezone" text NOT NULL,
	"currency" text NOT NULL,
	"source" text NOT NULL,
	"captured_minor" bigint DEFAULT 0 NOT NULL,
	"refunded_minor" bigint DEFAULT 0 NOT NULL,
	"paid_orders" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "report_sales_hours_hour_start_currency_source_pk" PRIMARY KEY("hour_start","currency","source")
);
--> statement-breakpoint
CREATE TABLE "report_search_days" (
	"local_day" text NOT NULL,
	"term" text NOT NULL,
	"timezone" text NOT NULL,
	"searches" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "report_search_days_local_day_term_pk" PRIMARY KEY("local_day","term")
);
--> statement-breakpoint
CREATE INDEX "report_sales_hours_local_day_idx" ON "report_sales_hours" USING btree ("local_day");