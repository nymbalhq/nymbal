-- Whose event each row is, so one record's history is an index range. The backfill mirrors `subjectOf`
-- (src/history/subject.ts): a subject needs a string id at the first path its type names, else the row has none.
ALTER TABLE "events" ADD COLUMN "subject_type" text;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "subject_id" text;--> statement-breakpoint
UPDATE "events" SET
  "subject_type" = CASE
    WHEN starts_with("type", 'product.') THEN 'product'
    WHEN starts_with("type", 'order.') OR starts_with("type", 'payment.') THEN 'order'
    WHEN starts_with("type", 'customer.') THEN 'customer'
    WHEN starts_with("type", 'inventory.') THEN 'variant'
  END,
  "subject_id" = CASE
    WHEN starts_with("type", 'product.') THEN CASE
      WHEN jsonb_typeof("envelope" #> '{payload,product,id}') = 'string' THEN "envelope" #>> '{payload,product,id}'
      WHEN jsonb_typeof("envelope" #> '{payload,productId}') = 'string' THEN "envelope" #>> '{payload,productId}'
    END
    WHEN starts_with("type", 'order.') OR starts_with("type", 'payment.') THEN CASE
      WHEN jsonb_typeof("envelope" #> '{payload,order,id}') = 'string' THEN "envelope" #>> '{payload,order,id}'
      WHEN jsonb_typeof("envelope" #> '{payload,orderId}') = 'string' THEN "envelope" #>> '{payload,orderId}'
    END
    WHEN starts_with("type", 'customer.') AND jsonb_typeof("envelope" #> '{payload,customerId}') = 'string'
      THEN "envelope" #>> '{payload,customerId}'
    WHEN starts_with("type", 'inventory.') AND jsonb_typeof("envelope" #> '{payload,variantId}') = 'string'
      THEN "envelope" #>> '{payload,variantId}'
  END;--> statement-breakpoint
UPDATE "events" SET "subject_type" = NULL WHERE "subject_id" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_subject_idx" ON "events" USING btree ("subject_type","subject_id","seq");
