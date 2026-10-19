ALTER TABLE `orders` ADD `cart_token` text;--> statement-breakpoint
-- The cart moves out of free-form metadata. Of several pending orders on one cart (made before this guard existed) only
-- the newest takes the token, so the index below can be built; the older ones stay as they are, without one.
UPDATE `orders` SET `cart_token` = json_extract(`metadata`, '$.cartToken')
WHERE json_valid(`metadata`) AND json_type(`metadata`, '$.cartToken') = 'text' AND (
	`status` <> 'pending' OR NOT EXISTS (
		SELECT 1 FROM `orders` AS `newer`
		WHERE `newer`.`status` = 'pending' AND `newer`.`sequence` > `orders`.`sequence`
			AND json_valid(`newer`.`metadata`)
			AND json_extract(`newer`.`metadata`, '$.cartToken') = json_extract(`orders`.`metadata`, '$.cartToken')
	)
);--> statement-breakpoint
CREATE UNIQUE INDEX `orders_pending_cart_unique` ON `orders` (`cart_token`) WHERE status = 'pending';
