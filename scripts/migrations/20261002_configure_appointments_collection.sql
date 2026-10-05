BEGIN;

-- US-26 / T-40: configure the existing "appointments" collection for Appointment Management.
--
-- Scope
--   * Reuses the existing appointments, customers, staff, services and appointmentServices
--     collections. No entity is duplicated; customer details stay on the customer record and
--     are reached through the appointments.customer relationship.
--   * Adds the one missing concept the US-26 UI needs: an appointment "category" that drives the
--     All / Sessions / Events filter. Every existing appointment is a single-customer service
--     booking, which is a Session; Event is reserved for group or special-occasion bookings.
--   * Hardens the schema with defaults, NOT NULL constraints, a time-ordering check and the
--     indexes the list, calendar and staff-scoped queries need.
--   * Keeps NocoBase field metadata and the US-19 role field grants aligned with the columns.
--
-- Requirements
--   * PostgreSQL main data source (DB_* values from .env). Run with `yarn migrate:appointments-collection`.
--   * Idempotent and non-destructive: no column, row or constraint is dropped and no data is invented.
--     The only data write is the category backfill of NULL -> 'session' for pre-existing rows.
--   * NOT NULL promotion is guarded: if any environment holds rows with a missing customer, date,
--     start time or status the migration stops with an explicit error instead of fabricating values.
--   * NocoBase caches collection metadata at startup, so restart the application after applying.
--   * Follow with `yarn validate:appointments-collection`.

-- ---------------------------------------------------------------------------
-- 0. Guards: the domain model we depend on must already exist exactly as expected.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "collections" WHERE "name" = 'appointments') THEN
    RAISE EXCEPTION 'appointments collection is missing; US-26 extends the existing collection and never creates a new one';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "fields"
    WHERE "collectionName" = 'appointments' AND "name" = 'customer' AND "type" = 'belongsTo'
      AND "options"->>'target' = 'customers' AND "options"->>'foreignKey' = 'customerId'
  ) THEN
    RAISE EXCEPTION 'Expected appointments.customer -> customers relationship is missing or misconfigured';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "fields"
    WHERE "collectionName" = 'appointments' AND "name" = 'staff' AND "type" = 'belongsTo'
      AND "options"->>'target' = 'staff' AND "options"->>'foreignKey' = 'staffId'
  ) THEN
    RAISE EXCEPTION 'Expected appointments.staff -> staff relationship is missing or misconfigured';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "fields"
    WHERE "collectionName" = 'appointments' AND "name" = 'appointmentServices' AND "type" = 'hasMany'
      AND "options"->>'target' = 'appointmentServices' AND "options"->>'foreignKey' = 'appointmentId'
  ) THEN
    RAISE EXCEPTION 'Expected appointments.appointmentServices relationship is missing or misconfigured';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "fields"
    WHERE "collectionName" = 'appointmentServices' AND "name" = 'service' AND "type" = 'belongsTo'
      AND "options"->>'target' = 'services' AND "options"->>'foreignKey' = 'serviceId'
  ) THEN
    RAISE EXCEPTION 'Expected appointmentServices.service -> services relationship is missing or misconfigured';
  END IF;

  IF EXISTS (SELECT 1 FROM "appointments" WHERE "customerId" IS NULL) THEN
    RAISE EXCEPTION 'appointments rows without a customer exist; resolve them before applying T-40 (no values are fabricated)';
  END IF;
  IF EXISTS (SELECT 1 FROM "appointments" WHERE "appointmentDate" IS NULL OR "startTime" IS NULL) THEN
    RAISE EXCEPTION 'appointments rows without appointmentDate/startTime exist; resolve them before applying T-40';
  END IF;
  IF EXISTS (SELECT 1 FROM "appointments" WHERE "status" IS NULL OR "status" = '') THEN
    RAISE EXCEPTION 'appointments rows without a status exist; resolve them before applying T-40';
  END IF;
  IF EXISTS (SELECT 1 FROM "appointments" WHERE "endTime" IS NOT NULL AND "endTime" <= "startTime") THEN
    RAISE EXCEPTION 'appointments rows with endTime <= startTime exist; resolve them before applying T-40';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1. Category column: Session (default) or Event.
-- ---------------------------------------------------------------------------
ALTER TABLE "appointments" ADD COLUMN IF NOT EXISTS "category" VARCHAR(255);

-- Pre-existing appointments are individual service bookings, i.e. sessions.
UPDATE "appointments" SET "category" = 'session' WHERE "category" IS NULL;

ALTER TABLE "appointments" ALTER COLUMN "category" SET DEFAULT 'session';
ALTER TABLE "appointments" ALTER COLUMN "category" SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'appointments_category_check') THEN
    ALTER TABLE "appointments"
      ADD CONSTRAINT appointments_category_check CHECK ("category" IN ('session', 'event'));
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Required columns, defaults and the time-ordering rule.
-- ---------------------------------------------------------------------------
ALTER TABLE "appointments" ALTER COLUMN "status" SET DEFAULT 'scheduled';
ALTER TABLE "appointments" ALTER COLUMN "status" SET NOT NULL;
ALTER TABLE "appointments" ALTER COLUMN "customerId" SET NOT NULL;
ALTER TABLE "appointments" ALTER COLUMN "appointmentDate" SET NOT NULL;
ALTER TABLE "appointments" ALTER COLUMN "startTime" SET NOT NULL;
-- staffId stays nullable: a booking can be created before a technician is assigned.
-- endTime stays nullable: it can be derived later from appointmentServices.durationAtBooking.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'appointments_status_check') THEN
    ALTER TABLE "appointments"
      ADD CONSTRAINT appointments_status_check
      CHECK ("status" IN ('scheduled', 'confirmed', 'inProgress', 'completed', 'cancelled', 'noShow'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'appointments_end_after_start') THEN
    ALTER TABLE "appointments"
      ADD CONSTRAINT appointments_end_after_start CHECK ("endTime" IS NULL OR "endTime" > "startTime");
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Indexes for the appointment list, calendar ordering, tabs and staff scope.
--    (customerId, staffId, createdById, updatedById and the US-01 customer-history index already exist.)
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS appointments_date_start
  ON "appointments" ("appointmentDate", "startTime");
CREATE INDEX IF NOT EXISTS appointments_staff_date
  ON "appointments" ("staffId", "appointmentDate", "startTime");
CREATE INDEX IF NOT EXISTS appointments_category_date
  ON "appointments" ("category", "appointmentDate" DESC);
CREATE INDEX IF NOT EXISTS appointments_status_date
  ON "appointments" ("status", "appointmentDate" DESC);

-- ---------------------------------------------------------------------------
-- 4. NocoBase field metadata.
-- ---------------------------------------------------------------------------
UPDATE "fields"
SET "type" = 'string',
    "interface" = 'select',
    "description" = 'Appointment category: Session (individual service booking) or Event (group or special occasion)',
    "options" = '{
      "defaultValue": "session",
      "enum": [
        {"value":"session","label":"Session","color":"blue"},
        {"value":"event","label":"Event","color":"purple"}
      ],
      "uiSchema": {
        "type": "string",
        "title": "Category",
        "x-component": "Select",
        "required": true,
        "default": "session",
        "enum": [
          {"value":"session","label":"Session","color":"blue"},
          {"value":"event","label":"Event","color":"purple"}
        ]
      }
    }'::json
WHERE "collectionName" = 'appointments' AND "name" = 'category';

INSERT INTO "fields" ("key", "name", "type", "interface", "description", "collectionName", "options", "sort")
SELECT 'appointment_category', 'category', 'string', 'select',
  'Appointment category: Session (individual service booking) or Event (group or special occasion)',
  'appointments',
  '{
    "defaultValue": "session",
    "enum": [
      {"value":"session","label":"Session","color":"blue"},
      {"value":"event","label":"Event","color":"purple"}
    ],
    "uiSchema": {
      "type": "string",
      "title": "Category",
      "x-component": "Select",
      "required": true,
      "default": "session",
      "enum": [
        {"value":"session","label":"Session","color":"blue"},
        {"value":"event","label":"Event","color":"purple"}
      ]
    }
  }'::json,
  COALESCE((SELECT MAX("sort") FROM "fields" WHERE "collectionName" = 'appointments'), 0) + 1
WHERE NOT EXISTS (
  SELECT 1 FROM "fields" WHERE "collectionName" = 'appointments' AND "name" = 'category'
);

-- Mark the columns that are now NOT NULL as required in the form metadata and give status its default.
UPDATE "fields"
SET "options" = jsonb_set("options"::jsonb, '{uiSchema,required}', 'true'::jsonb, TRUE)::json
WHERE "collectionName" = 'appointments' AND "name" IN ('customer', 'appointmentDate', 'startTime');

UPDATE "fields"
SET "options" = jsonb_set(
      jsonb_set("options"::jsonb, '{uiSchema,required}', 'true'::jsonb, TRUE),
      '{defaultValue}', '"scheduled"'::jsonb, TRUE
    )::json
WHERE "collectionName" = 'appointments' AND "name" = 'status';

-- ---------------------------------------------------------------------------
-- 5. Keep the US-19 role grants aligned: the roles that may read or write appointments
--    also get the new column. Scopes ("Assigned to me (staff)") are untouched.
-- ---------------------------------------------------------------------------
UPDATE "dataSourcesRolesResourcesActions" AS a
SET "fields" = a."fields" || '["category"]'::jsonb,
    "updatedAt" = NOW()
FROM "dataSourcesRolesResources" AS r
WHERE r."id" = a."rolesResourceId"
  AND r."dataSourceKey" = 'main'
  AND r."name" = 'appointments'
  AND r."roleName" IN ('r_staff', 'r_receptionist')
  AND a."name" IN ('view', 'create', 'update')
  AND NOT (a."fields" ? 'category');

COMMIT;
