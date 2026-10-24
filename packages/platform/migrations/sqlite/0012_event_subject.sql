-- Whose event each row is, so one record's history is an index range. The backfill mirrors `subjectOf`
-- (src/history/subject.ts): a subject needs a string id at the first path its type names, else the row has none.
ALTER TABLE `events` ADD `subject_type` text;--> statement-breakpoint
ALTER TABLE `events` ADD `subject_id` text;--> statement-breakpoint
UPDATE `events` SET
  `subject_type` = CASE
    WHEN `type` GLOB 'product.*' THEN 'product'
    WHEN `type` GLOB 'order.*' OR `type` GLOB 'payment.*' THEN 'order'
    WHEN `type` GLOB 'customer.*' THEN 'customer'
    WHEN `type` GLOB 'inventory.*' THEN 'variant'
  END,
  `subject_id` = CASE
    WHEN `type` GLOB 'product.*' THEN CASE
      WHEN json_type(`envelope`, '$.payload.product.id') = 'text' THEN json_extract(`envelope`, '$.payload.product.id')
      WHEN json_type(`envelope`, '$.payload.productId') = 'text' THEN json_extract(`envelope`, '$.payload.productId')
    END
    WHEN `type` GLOB 'order.*' OR `type` GLOB 'payment.*' THEN CASE
      WHEN json_type(`envelope`, '$.payload.order.id') = 'text' THEN json_extract(`envelope`, '$.payload.order.id')
      WHEN json_type(`envelope`, '$.payload.orderId') = 'text' THEN json_extract(`envelope`, '$.payload.orderId')
    END
    WHEN `type` GLOB 'customer.*' AND json_type(`envelope`, '$.payload.customerId') = 'text'
      THEN json_extract(`envelope`, '$.payload.customerId')
    WHEN `type` GLOB 'inventory.*' AND json_type(`envelope`, '$.payload.variantId') = 'text'
      THEN json_extract(`envelope`, '$.payload.variantId')
  END;--> statement-breakpoint
UPDATE `events` SET `subject_type` = NULL WHERE `subject_id` IS NULL;--> statement-breakpoint
CREATE INDEX `events_subject_idx` ON `events` (`subject_type`,`subject_id`,`seq`);
