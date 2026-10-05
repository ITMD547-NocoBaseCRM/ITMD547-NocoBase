BEGIN;

-- US-26 / T-42: human-readable labels for the relations the appointment UI renders.
--
-- Every CRM collection still declares "id" as its title field, so relation pickers and
-- association columns show raw snowflake ids. This migration only changes presentation
-- metadata: collection titleField and the relation fields' fieldNames.label. No table
-- or data is touched. Idempotent; restart NocoBase afterwards so metadata is reloaded.

-- Collection-level title fields (used by pickers, association columns and flow-surface authoring).
UPDATE "collections"
SET "options" = jsonb_set(COALESCE("options"::jsonb, '{}'::jsonb), '{titleField}', '"firstName"'::jsonb, TRUE)::json
WHERE "name" IN ('customers', 'staff');

UPDATE "collections"
SET "options" = jsonb_set(COALESCE("options"::jsonb, '{}'::jsonb), '{titleField}', '"name"'::jsonb, TRUE)::json
WHERE "name" IN ('services', 'serviceCategories');

-- A booked-service line has no name of its own; price at booking is the most useful readable label.
UPDATE "collections"
SET "options" = jsonb_set(COALESCE("options"::jsonb, '{}'::jsonb), '{titleField}', '"priceAtBooking"'::jsonb, TRUE)::json
WHERE "name" = 'appointmentServices';

-- Relation fields on the appointment side: label by a readable target field instead of id.
UPDATE "fields"
SET "options" = jsonb_set("options"::jsonb, '{uiSchema,x-component-props,fieldNames,label}', '"firstName"'::jsonb, TRUE)::json
WHERE "collectionName" = 'appointments' AND "name" IN ('customer', 'staff');

UPDATE "fields"
SET "options" = jsonb_set("options"::jsonb, '{uiSchema,x-component-props,fieldNames,label}', '"name"'::jsonb, TRUE)::json
WHERE "collectionName" = 'appointmentServices' AND "name" = 'service';

-- A booked-service line has no name of its own; price at booking is the most useful readable label.
UPDATE "fields"
SET "options" = jsonb_set("options"::jsonb, '{uiSchema,x-component-props,fieldNames,label}', '"priceAtBooking"'::jsonb, TRUE)::json
WHERE "collectionName" = 'appointments' AND "name" = 'appointmentServices';

COMMIT;
