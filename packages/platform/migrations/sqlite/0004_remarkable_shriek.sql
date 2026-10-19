ALTER TABLE `customers` ADD `roles` text DEFAULT '["customer"]' NOT NULL;--> statement-breakpoint
-- Roles move out of free-form metadata: known roles survive, a row left with none keeps the column's ['customer'].
UPDATE `customers` SET `roles` = (
	SELECT json_group_array(DISTINCT `r`.`value`) FROM json_each(`customers`.`metadata`, '$.roles') AS `r`
	WHERE `r`.`type` = 'text' AND `r`.`value` IN ('admin', 'customer', 'guest')
)
WHERE json_valid(`metadata`) AND json_type(`metadata`, '$.roles') = 'array' AND EXISTS (
	SELECT 1 FROM json_each(`customers`.`metadata`, '$.roles') AS `r`
	WHERE `r`.`type` = 'text' AND `r`.`value` IN ('admin', 'customer', 'guest')
);--> statement-breakpoint
UPDATE `customers` SET `metadata` = json_remove(`metadata`, '$.roles')
WHERE json_valid(`metadata`) AND json_type(`metadata`, '$.roles') IS NOT NULL;
