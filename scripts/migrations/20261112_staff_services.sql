BEGIN;

-- Phase 1: a normalized, initially empty staff-to-service many-to-many relation.
-- staff.services and services.staff are NocoBase association fields backed by
-- this collection; no serialized services column is added to staff.
--
-- Safe to rerun. Existing links are preserved; invalid or duplicate links stop
-- the migration rather than being repaired or deleted implicitly.

DO $$
DECLARE
  source_id_type TEXT;
  target_id_type TEXT;
  expected_column RECORD;
  actual_type TEXT;
  has_invalid_links BOOLEAN;
  has_duplicate_ids BOOLEAN;
  has_duplicate_pairs BOOLEAN;
  has_dangling_staff BOOLEAN;
  has_dangling_services BOOLEAN;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "collections" WHERE "name" = 'staff')
     OR NOT EXISTS (SELECT 1 FROM "collections" WHERE "name" = 'services') THEN
    RAISE EXCEPTION 'Expected staff and services NocoBase collections before creating staffServices';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "fields"
    WHERE "collectionName" = 'staff' AND "name" = 'id' AND "type" = 'snowflakeId'
  ) OR NOT EXISTS (
    SELECT 1 FROM "fields"
    WHERE "collectionName" = 'services' AND "name" = 'id' AND "type" = 'snowflakeId'
  ) THEN
    RAISE EXCEPTION 'Expected staff.id and services.id to be NocoBase snowflakeId fields';
  END IF;

  SELECT udt_name INTO source_id_type
  FROM information_schema.columns
  WHERE table_schema = current_schema() AND table_name = 'staff' AND column_name = 'id';
  SELECT udt_name INTO target_id_type
  FROM information_schema.columns
  WHERE table_schema = current_schema() AND table_name = 'services' AND column_name = 'id';
  IF source_id_type IS DISTINCT FROM 'int8' OR target_id_type IS DISTINCT FROM 'int8' THEN
    RAISE EXCEPTION 'Expected staff.id and services.id to be bigint columns (found %, %)', source_id_type, target_id_type;
  END IF;

  IF EXISTS (
    SELECT 1 FROM "fields"
    WHERE "collectionName" = 'staff' AND "name" = 'services'
      AND NOT (
        "type" = 'belongsToMany' AND "interface" = 'm2m'
        AND "options"->>'target' = 'services'
        AND "options"->>'through' = 'staffServices'
        AND "options"->>'foreignKey' = 'staffId'
        AND "options"->>'otherKey' = 'serviceId'
      )
  ) OR EXISTS (
    SELECT 1 FROM "fields"
    WHERE "collectionName" = 'services' AND "name" = 'staff'
      AND NOT (
        "type" = 'belongsToMany' AND "interface" = 'm2m'
        AND "options"->>'target' = 'staff'
        AND "options"->>'through' = 'staffServices'
        AND "options"->>'foreignKey' = 'serviceId'
        AND "options"->>'otherKey' = 'staffId'
      )
  ) THEN
    RAISE EXCEPTION 'A staff.services or services.staff field already exists with incompatible relation metadata';
  END IF;

  IF EXISTS (SELECT 1 FROM "collections" WHERE "key" = 'staff_services' AND "name" <> 'staffServices') THEN
    RAISE EXCEPTION 'Collection key staff_services is already used by a different collection';
  END IF;

  IF to_regclass(format('%I.%I', current_schema(), 'staffServices')) IS NOT NULL THEN
    FOR expected_column IN
      SELECT * FROM (VALUES
        ('id', 'int8'),
        ('staffId', 'int8'),
        ('serviceId', 'int8'),
        ('createdAt', 'timestamptz'),
        ('updatedAt', 'timestamptz'),
        ('createdById', 'int8'),
        ('updatedById', 'int8')
      ) AS required(column_name, udt_name)
    LOOP
      SELECT c.udt_name INTO actual_type
      FROM information_schema.columns AS c
      WHERE c.table_schema = current_schema()
        AND c.table_name = 'staffServices'
        AND c.column_name = expected_column.column_name;
      IF actual_type IS DISTINCT FROM expected_column.udt_name THEN
        RAISE EXCEPTION 'Existing staffServices.%. expected %, found %', expected_column.column_name, expected_column.udt_name, actual_type;
      END IF;
      actual_type := NULL;
    END LOOP;

    EXECUTE 'SELECT EXISTS (SELECT 1 FROM "staffServices" WHERE "id" IS NULL)'
      INTO has_invalid_links;
    IF has_invalid_links THEN
      RAISE EXCEPTION 'Existing staffServices rows have a NULL id';
    END IF;
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM "staffServices" GROUP BY "id" HAVING COUNT(*) > 1)'
      INTO has_duplicate_ids;
    IF has_duplicate_ids THEN
      RAISE EXCEPTION 'Duplicate staffServices IDs exist; resolve them before migration';
    END IF;
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM "staffServices" WHERE "staffId" IS NULL OR "serviceId" IS NULL)'
      INTO has_invalid_links;
    IF has_invalid_links THEN
      RAISE EXCEPTION 'Existing staffServices rows have a NULL staffId or serviceId';
    END IF;
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM "staffServices" GROUP BY "staffId", "serviceId" HAVING COUNT(*) > 1)'
      INTO has_duplicate_pairs;
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM "staffServices" ss LEFT JOIN "staff" s ON s."id" = ss."staffId" WHERE s."id" IS NULL)'
      INTO has_dangling_staff;
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM "staffServices" ss LEFT JOIN "services" s ON s."id" = ss."serviceId" WHERE s."id" IS NULL)'
      INTO has_dangling_services;
    IF has_invalid_links OR has_duplicate_pairs OR has_dangling_staff OR has_dangling_services THEN
      RAISE EXCEPTION 'Existing staffServices rows are invalid (null keys: %, duplicate pairs: %, dangling staff: %, dangling services: %); resolve them before migration',
        has_invalid_links, has_duplicate_pairs, has_dangling_staff, has_dangling_services;
    END IF;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "staffServices" (
  "id" BIGINT NOT NULL,
  "staffId" BIGINT NOT NULL,
  "serviceId" BIGINT NOT NULL,
  "createdAt" TIMESTAMP WITH TIME ZONE,
  "updatedAt" TIMESTAMP WITH TIME ZONE,
  "createdById" BIGINT,
  "updatedById" BIGINT,
  CONSTRAINT staff_services_pkey PRIMARY KEY ("id")
);

DO $$
DECLARE
  through_table REGCLASS := to_regclass(format('%I.%I', current_schema(), 'staffServices'));
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = through_table AND contype = 'p') THEN
    ALTER TABLE "staffServices" ADD CONSTRAINT staff_services_pkey PRIMARY KEY ("id");
  END IF;
END $$;

ALTER TABLE "staffServices" ALTER COLUMN "staffId" SET NOT NULL;
ALTER TABLE "staffServices" ALTER COLUMN "serviceId" SET NOT NULL;

DO $$
DECLARE
  through_table REGCLASS := to_regclass(format('%I.%I', current_schema(), 'staffServices'));
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = through_table AND conname = 'staff_services_staff_fk') THEN
    ALTER TABLE "staffServices"
      ADD CONSTRAINT staff_services_staff_fk
      FOREIGN KEY ("staffId") REFERENCES "staff" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = through_table AND conname = 'staff_services_service_fk') THEN
    ALTER TABLE "staffServices"
      ADD CONSTRAINT staff_services_service_fk
      FOREIGN KEY ("serviceId") REFERENCES "services" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = through_table AND conname = 'staff_services_pair_unique') THEN
    ALTER TABLE "staffServices"
      ADD CONSTRAINT staff_services_pair_unique UNIQUE ("staffId", "serviceId");
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS staff_services_service_id_idx ON "staffServices" ("serviceId");
CREATE INDEX IF NOT EXISTS staff_services_created_by_id_idx ON "staffServices" ("createdById");
CREATE INDEX IF NOT EXISTS staff_services_updated_by_id_idx ON "staffServices" ("updatedById");

INSERT INTO "collections" ("key", "name", "title", "inherit", "hidden", "options", "description", "sort")
SELECT
  'staff_services',
  'staffServices',
  'Staff services',
  FALSE,
  FALSE,
  '{"logging":true,"template":"general","autoGenId":false,"titleField":"staffId","filterTargetKey":["id"]}'::json,
  'Staff-to-service eligibility links',
  COALESCE((SELECT MAX("sort") FROM "collections"), 0) + 1
WHERE NOT EXISTS (SELECT 1 FROM "collections" WHERE "name" = 'staffServices');

WITH field_specs(position, field_key, field_name, field_type, field_interface, field_description, collection_name, reverse_key, field_options) AS (
  VALUES
    (1, 'staff_services_id', 'id', 'snowflakeId', 'snowflakeId', NULL, 'staffServices', NULL,
      '{"uiSchema":{"type":"number","title":"ID","x-component":"InputNumber","x-component-props":{"stringMode":true,"step":"1"},"x-validator":"integer"},"primaryKey":true,"allowNull":false,"autoIncrement":false}'::json),
    (2, 'staff_services_staff_id', 'staffId', 'bigInt', 'integer', 'Staff identifier', 'staffServices', NULL,
      '{"isForeignKey":true,"allowNull":false,"uiSchema":{"type":"number","title":"Staff ID","x-component":"InputNumber","x-read-pretty":true}}'::json),
    (3, 'staff_services_service_id', 'serviceId', 'bigInt', 'integer', 'Service identifier', 'staffServices', NULL,
      '{"isForeignKey":true,"allowNull":false,"uiSchema":{"type":"number","title":"Service ID","x-component":"InputNumber","x-read-pretty":true}}'::json),
    (4, 'staff_services_created_at', 'createdAt', 'date', 'createdAt', NULL, 'staffServices', NULL,
      '{"uiSchema":{"type":"datetime","title":"Created at","x-component":"DatePicker","x-read-pretty":true,"x-component-props":{"dateFormat":"MMM-DD-YYYY"}},"field":"createdAt"}'::json),
    (5, 'staff_services_created_by', 'createdBy', 'belongsTo', 'createdBy', NULL, 'staffServices', NULL,
      '{"uiSchema":{"type":"object","title":"Created by","x-component":"AssociationField","x-component-props":{"fieldNames":{"value":"id","label":"nickname"}},"x-read-pretty":true},"target":"users","foreignKey":"createdById","targetKey":"id"}'::json),
    (6, 'staff_services_updated_at', 'updatedAt', 'date', 'updatedAt', NULL, 'staffServices', NULL,
      '{"uiSchema":{"type":"datetime","title":"Last updated at","x-component":"DatePicker","x-read-pretty":true,"x-component-props":{"dateFormat":"MMM-DD-YYYY"}},"field":"updatedAt"}'::json),
    (7, 'staff_services_updated_by', 'updatedBy', 'belongsTo', 'updatedBy', NULL, 'staffServices', NULL,
      '{"uiSchema":{"type":"object","title":"Last updated by","x-component":"AssociationField","x-component-props":{"fieldNames":{"value":"id","label":"nickname"}},"x-read-pretty":true},"target":"users","foreignKey":"updatedById","targetKey":"id"}'::json),
    (8, 'staff_services_services_relation', 'services', 'belongsToMany', 'm2m', NULL, 'staff', 'services_staff_staff_relation',
      '{"target":"services","through":"staffServices","foreignKey":"staffId","otherKey":"serviceId","sourceKey":"id","targetKey":"id","onDelete":"CASCADE","uiSchema":{"type":"array","title":"Services","x-component":"AssociationField","x-component-props":{"multiple":true,"fieldNames":{"value":"id","label":"name"}}}}'::json),
    (9, 'services_staff_staff_relation', 'staff', 'belongsToMany', 'm2m', NULL, 'services', 'staff_services_services_relation',
      '{"target":"staff","through":"staffServices","foreignKey":"serviceId","otherKey":"staffId","sourceKey":"id","targetKey":"id","onDelete":"CASCADE","uiSchema":{"type":"array","title":"Staff","x-component":"AssociationField","x-component-props":{"multiple":true,"fieldNames":{"value":"id","label":"firstName"}}}}'::json)
), missing AS (
  SELECT spec.*
  FROM field_specs spec
  WHERE NOT EXISTS (
    SELECT 1 FROM "fields" field
    WHERE field."collectionName" = spec.collection_name AND field."name" = spec.field_name
  )
)
INSERT INTO "fields" ("key", "name", "type", "interface", "description", "collectionName", "reverseKey", "options", "sort")
SELECT
  missing.field_key,
  missing.field_name,
  missing.field_type,
  missing.field_interface,
  missing.field_description,
  missing.collection_name,
  missing.reverse_key,
  missing.field_options,
  COALESCE((SELECT MAX("sort") FROM "fields" WHERE "collectionName" = missing.collection_name), 0) + missing.position
FROM missing
ORDER BY missing.collection_name, missing.position;

COMMIT;