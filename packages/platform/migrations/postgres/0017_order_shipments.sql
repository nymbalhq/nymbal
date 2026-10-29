CREATE TABLE IF NOT EXISTS "order_shipments" (
	"order_id" text PRIMARY KEY NOT NULL,
	"carrier" text NOT NULL,
	"tracking_number" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "order_shipments" ADD CONSTRAINT "order_shipments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_shipments_tracking_number_idx" ON "order_shipments" USING btree ("tracking_number");