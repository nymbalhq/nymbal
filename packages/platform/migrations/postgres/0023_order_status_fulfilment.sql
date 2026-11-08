-- A refund is money: `status` and `order_history` carry fulfilment only. Each order's history is walked in (timestamp,
-- id) order; a money status becomes the fulfilment status the walk had reached (confirmed before anything), the status
-- the row left when the row came from one. Rows, notes and timestamps stay as they were.
WITH RECURSIVE "ordered" AS (
  SELECT "id", "order_id", "from_status", "to_status",
    row_number() OVER (PARTITION BY "order_id" ORDER BY "timestamp", "id") AS "n"
  FROM "order_history"
  WHERE "order_id" IN (
    SELECT "order_id" FROM "order_history"
    WHERE "from_status" IN ('refunded', 'partially_refunded') OR "to_status" IN ('refunded', 'partially_refunded')
  )
),
"walked" AS (
  SELECT "id", "order_id", "n",
    CASE WHEN "from_status" IN ('refunded', 'partially_refunded') THEN 'confirmed' ELSE "from_status" END AS "new_from",
    CASE WHEN "to_status" IN ('refunded', 'partially_refunded') THEN CASE WHEN "from_status" IS NULL OR "from_status" IN ('refunded', 'partially_refunded') THEN 'confirmed' ELSE "from_status" END ELSE "to_status" END AS "new_to"
  FROM "ordered"
  WHERE "n" = 1
  UNION ALL
  SELECT o."id", o."order_id", o."n",
    CASE WHEN o."from_status" IN ('refunded', 'partially_refunded') THEN w."new_to" ELSE o."from_status" END,
    CASE WHEN o."to_status" IN ('refunded', 'partially_refunded') THEN CASE WHEN o."from_status" IS NULL OR o."from_status" IN ('refunded', 'partially_refunded') THEN w."new_to" ELSE o."from_status" END ELSE o."to_status" END
  FROM "ordered" o
  JOIN "walked" w ON o."order_id" = w."order_id" AND o."n" = w."n" + 1
)
UPDATE "order_history" h
SET "from_status" = w."new_from", "to_status" = w."new_to"
FROM "walked" w
WHERE h."id" = w."id";--> statement-breakpoint
-- An order at a money status reads where its rewritten history ended; with no history, shipped if a shipment exists.
UPDATE "orders" SET "status" = COALESCE(
  (SELECT h."to_status" FROM "order_history" h WHERE h."order_id" = "orders"."id" ORDER BY h."timestamp" DESC, h."id" DESC LIMIT 1),
  CASE WHEN EXISTS (SELECT 1 FROM "order_shipments" s WHERE s."order_id" = "orders"."id") THEN 'shipped' ELSE 'confirmed' END
)
WHERE "status" IN ('refunded', 'partially_refunded');
