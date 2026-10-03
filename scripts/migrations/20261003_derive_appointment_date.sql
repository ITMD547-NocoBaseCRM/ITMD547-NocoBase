BEGIN;

-- US-26 / T-46: the appointment date is created from the start time instead of being typed.
--
-- Staff already enter a start time (and an end time). Asking for a separate date meant typing it twice, as free text,
-- with nothing to stop the two disagreeing, and the create form lost the field entirely. The date is now always the
-- calendar date of startTime in the salon's time zone, set by a trigger so that the screens, the REST API and imports
-- all agree. An appointment that runs past midnight keeps the date it started on; endTime only has to be after startTime.
--
-- Time zone: the database setting crm.salon_timezone, default America/Chicago. Change it for the whole database with
--   ALTER DATABASE <name> SET crm.salon_timezone = 'Europe/London';
-- The existing rows are not touched (every one already agrees with its start time); the migration reports any that do not.
--
-- Idempotent. Run with `yarn migrate:appointment-date`.

CREATE OR REPLACE FUNCTION appointments_derive_date() RETURNS TRIGGER AS $$
DECLARE
  salon_timezone TEXT := COALESCE(NULLIF(current_setting('crm.salon_timezone', true), ''), 'America/Chicago');
BEGIN
  IF NEW."startTime" IS NOT NULL THEN
    NEW."appointmentDate" := (NEW."startTime" AT TIME ZONE salon_timezone)::date;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- BEFORE triggers run before the NOT NULL check, so an insert without a date is valid as long as it has a start time.
DROP TRIGGER IF EXISTS appointments_derive_date ON "appointments";
CREATE TRIGGER appointments_derive_date
  BEFORE INSERT OR UPDATE OF "startTime", "appointmentDate" ON "appointments"
  FOR EACH ROW
  EXECUTE FUNCTION appointments_derive_date();

DO $$
DECLARE
  salon_timezone TEXT := COALESCE(NULLIF(current_setting('crm.salon_timezone', true), ''), 'America/Chicago');
  disagreeing INTEGER;
BEGIN
  SELECT COUNT(*) INTO disagreeing
  FROM "appointments"
  WHERE "appointmentDate" IS DISTINCT FROM ("startTime" AT TIME ZONE salon_timezone)::date;
  IF disagreeing > 0 THEN
    RAISE NOTICE '% existing appointments have a date that differs from their start time in %; they are left as they are and will be corrected the next time their start time or date is saved', disagreeing, salon_timezone;
  END IF;
END $$;

-- NocoBase metadata: still NOT NULL in the database, but a person no longer has to fill it in, and it is shown read-only.
UPDATE "fields"
SET "options" = jsonb_set(
      jsonb_set("options"::jsonb, '{uiSchema,required}', 'false'::jsonb, TRUE),
      '{uiSchema,x-read-pretty}', 'true'::jsonb, TRUE
    )::json,
    "description" = 'Calendar date of the start time in the salon time zone; set automatically'
WHERE "collectionName" = 'appointments' AND "name" = 'appointmentDate';

COMMIT;
