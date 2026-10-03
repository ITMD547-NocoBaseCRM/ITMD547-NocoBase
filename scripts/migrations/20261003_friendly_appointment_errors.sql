BEGIN;

-- US-26 / T-46: readable messages for the rules the database enforces.
--
-- NocoBase shows the database's own message when a save or delete is refused. For an appointment that ends before it
-- starts that was: new row for relation "appointments" violates check constraint "appointments_end_after_start".
-- These triggers refuse the same changes first, with a sentence a person can act on. The constraints and foreign keys
-- stay in place as the hard guarantee; the triggers only change what the user is told.
--
--   * end time must be after start time
--   * a customer who has appointments cannot be deleted
--   * a service that has been booked cannot be deleted
--
-- Idempotent. Run with `yarn migrate:appointment-messages`.

CREATE OR REPLACE FUNCTION appointments_check_times() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."startTime" IS NOT NULL AND NEW."endTime" IS NOT NULL AND NEW."endTime" <= NEW."startTime" THEN
    RAISE EXCEPTION 'The end time must be after the start time.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS appointments_check_times ON "appointments";
CREATE TRIGGER appointments_check_times
  BEFORE INSERT OR UPDATE OF "startTime", "endTime" ON "appointments"
  FOR EACH ROW
  EXECUTE FUNCTION appointments_check_times();

CREATE OR REPLACE FUNCTION customers_refuse_delete_with_appointments() RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "appointments" WHERE "customerId" = OLD."id") THEN
    RAISE EXCEPTION 'This customer has appointments and cannot be deleted. Delete or reassign their appointments first.' USING ERRCODE = '23503';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS customers_refuse_delete_with_appointments ON "customers";
CREATE TRIGGER customers_refuse_delete_with_appointments
  BEFORE DELETE ON "customers"
  FOR EACH ROW
  EXECUTE FUNCTION customers_refuse_delete_with_appointments();

CREATE OR REPLACE FUNCTION services_refuse_delete_when_booked() RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "appointmentServices" WHERE "serviceId" = OLD."id") THEN
    RAISE EXCEPTION 'This service has been booked on appointments and cannot be deleted. Mark it inactive instead.' USING ERRCODE = '23503';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS services_refuse_delete_when_booked ON "services";
CREATE TRIGGER services_refuse_delete_when_booked
  BEFORE DELETE ON "services"
  FOR EACH ROW
  EXECUTE FUNCTION services_refuse_delete_when_booked();

COMMIT;
