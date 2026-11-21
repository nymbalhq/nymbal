ALTER TABLE "orders" ADD COLUMN "prices_include_tax" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "tax_code" text;--> statement-breakpoint
ALTER TABLE "variants" ADD COLUMN "tax_code" text;