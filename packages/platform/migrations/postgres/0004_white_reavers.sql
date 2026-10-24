ALTER TABLE "customers" ADD COLUMN "roles" jsonb DEFAULT '["customer"]'::jsonb NOT NULL;--> statement-breakpoint
-- Roles move out of free-form metadata: known roles survive, a row left with none keeps the column's ['customer'].
UPDATE "customers" SET "roles" = "kept"."roles"
FROM (
	SELECT "c"."id", jsonb_agg(DISTINCT "r"."role") AS "roles"
	FROM "customers" AS "c"
	CROSS JOIN LATERAL jsonb_array_elements(
		CASE WHEN jsonb_typeof("c"."metadata"->'roles') = 'array' THEN "c"."metadata"->'roles' ELSE '[]'::jsonb END
	) AS "r"("role")
	WHERE "r"."role" IN ('"admin"'::jsonb, '"customer"'::jsonb, '"guest"'::jsonb)
	GROUP BY "c"."id"
) AS "kept"
WHERE "customers"."id" = "kept"."id";--> statement-breakpoint
UPDATE "customers" SET "metadata" = "metadata" - 'roles'
WHERE jsonb_typeof("metadata") = 'object' AND "metadata" ? 'roles';
