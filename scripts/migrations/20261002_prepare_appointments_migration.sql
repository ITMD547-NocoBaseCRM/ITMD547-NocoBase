BEGIN;

-- US-26 / T-41: make the appointments collection migration-ready.
--
-- The source of legacy appointment data is not confirmed (see docs/appointments-migration.md),
-- so this migration moves NO data. It only adds the stable identity columns a future import
-- needs to be idempotent and to report duplicates without matching on customer names.
--
--   externalSource  short code of the system a row was imported from (e.g. 'azure-sql').
--   externalId      the appointment's primary identifier in that system.
--
-- Both columns stay NULL for appointments created inside NocoBase. A partial unique index
-- guarantees one NocoBase appointment per (externalSource, externalId) pair, which is what makes
-- re-running an import safe.
--
-- Requirements: PostgreSQL main data source; run after 20261002_configure_appointments_collection.sql
-- with `yarn migrate:appointments-migration-prep`; idempotent; non-destructive; restart NocoBase afterwards.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'appointments' AND column_name = 'category'
  ) THEN
    RAISE EXCEPTION 'Run 20261002_configure_appointments_collection.sql (T-40) before this migration';
  END IF;
END $$;

ALTER TABLE "appointments" ADD COLUMN IF NOT EXISTS "externalSource" VARCHAR(64);
ALTER TABLE "appointments" ADD COLUMN IF NOT EXISTS "externalId" VARCHAR(255);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'appointments_external_identity_pair') THEN
    ALTER TABLE "appointments"
      ADD CONSTRAINT appointments_external_identity_pair
      CHECK (("externalSource" IS NULL) = ("externalId" IS NULL));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS appointments_external_identity
  ON "appointments" ("externalSource", "externalId")
  WHERE "externalId" IS NOT NULL;

-- NocoBase field metadata: read-only identifiers, shown pretty, never edited by hand.
INSERT INTO "fields" ("key", "name", "type", "interface", "description", "collectionName", "options", "sort")
SELECT 'appointment_external_source', 'externalSource', 'string', 'input',
  'System the appointment was imported from; NULL for appointments created in NocoBase',
  'appointments',
  '{"uiSchema":{"type":"string","title":"External source","x-component":"Input","x-read-pretty":true}}'::json,
  COALESCE((SELECT MAX("sort") FROM "fields" WHERE "collectionName" = 'appointments'), 0) + 1
WHERE NOT EXISTS (
  SELECT 1 FROM "fields" WHERE "collectionName" = 'appointments' AND "name" = 'externalSource'
);

INSERT INTO "fields" ("key", "name", "type", "interface", "description", "collectionName", "options", "sort")
SELECT 'appointment_external_id', 'externalId', 'string', 'input',
  'Appointment identifier in the external source; unique per source',
  'appointments',
  '{"uiSchema":{"type":"string","title":"External ID","x-component":"Input","x-read-pretty":true}}'::json,
  COALESCE((SELECT MAX("sort") FROM "fields" WHERE "collectionName" = 'appointments'), 0) + 1
WHERE NOT EXISTS (
  SELECT 1 FROM "fields" WHERE "collectionName" = 'appointments' AND "name" = 'externalId'
);

COMMIT;
