BEGIN;

-- US-26 / T-42: deleting an appointment must also remove its booked-service lines.
--
-- appointmentServices rows are pure children of an appointment (price and duration at booking);
-- without a cascading foreign key the Delete action leaves orphan lines behind. Payments are NOT
-- cascaded: they are financial records and keep their own lifecycle.
--
-- Idempotent and non-destructive. The migration refuses to run if orphan lines already exist so that
-- no data is silently dropped; clean them up explicitly first.

DO $$
DECLARE
  orphan_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO orphan_count
  FROM "appointmentServices" s
  LEFT JOIN "appointments" a ON a."id" = s."appointmentId"
  WHERE s."appointmentId" IS NOT NULL AND a."id" IS NULL;

  IF orphan_count > 0 THEN
    RAISE EXCEPTION '% appointmentServices rows reference a missing appointment; resolve them before adding the cascade', orphan_count;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'appointment_services_appointment_fk') THEN
    ALTER TABLE "appointmentServices"
      ADD CONSTRAINT appointment_services_appointment_fk
      FOREIGN KEY ("appointmentId") REFERENCES "appointments" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- Keep NocoBase metadata in step with the database behaviour.
UPDATE "fields"
SET "options" = jsonb_set("options"::jsonb, '{onDelete}', '"CASCADE"'::jsonb, TRUE)::json
WHERE "collectionName" = 'appointments' AND "name" = 'appointmentServices';

UPDATE "fields"
SET "options" = jsonb_set("options"::jsonb, '{onDelete}', '"CASCADE"'::jsonb, TRUE)::json
WHERE "collectionName" = 'appointmentServices' AND "name" = 'appointment';

COMMIT;
