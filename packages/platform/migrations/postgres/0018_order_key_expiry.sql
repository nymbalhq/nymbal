-- Every key gets an expiry. A migration reads no config, so existing rows get the default lifetimes: 48 hours for a
-- checkout key, 30 days for an email key, written in hours so the session's time zone cannot move a day across DST.
ALTER TABLE "order_access_keys" ADD COLUMN "expires_at" timestamp with time zone;
--> statement-breakpoint
UPDATE "order_access_keys"
SET "expires_at" = "created_at" + CASE "purpose" WHEN 'email' THEN interval '720 hours' ELSE interval '48 hours' END;
--> statement-breakpoint
ALTER TABLE "order_access_keys" ALTER COLUMN "expires_at" SET NOT NULL;
