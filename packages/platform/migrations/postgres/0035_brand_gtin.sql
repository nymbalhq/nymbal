ALTER TABLE "products" ADD COLUMN "brand" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "variants" ADD COLUMN "gtin" text;