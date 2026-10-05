BEGIN;

-- US-26 / T-46: appointments must not reference records that do not exist, and removing a booked service from an
-- appointment must not leave an orphan row behind. Both were found by the integration tests.
--
--   1. Reference integrity. appointments.customerId, appointments.staffId and appointmentServices.serviceId were plain
--      numbers: the API accepted an appointment for a customer, technician or service that does not exist. They are
--      now foreign keys:
--        customer   ON DELETE RESTRICT   a customer with appointments cannot be deleted (history is kept)
--        technician ON DELETE SET NULL   deleting a technician leaves their appointments unassigned
--        service    ON DELETE RESTRICT   a booked service keeps its service
--   2. Orphan lines. The edit form sends the remaining service lines; NocoBase then detaches the removed ones by setting
--      appointmentServices.appointmentId to NULL instead of deleting them. A line without an appointment has no meaning,
--      so detaching a line now deletes it.
--
-- Idempotent and non-destructive: nothing is dropped, and the migration refuses to run if existing rows already
-- break a rule, so no data is silently changed. Run with `yarn migrate:appointment-references`.

DO $$
DECLARE
  dangling_customers INTEGER;
  dangling_staff INTEGER;
  dangling_services INTEGER;
  orphan_lines INTEGER;
BEGIN
  SELECT COUNT(*) INTO dangling_customers
  FROM "appointments" a LEFT JOIN "customers" c ON c."id" = a."customerId"
  WHERE a."customerId" IS NOT NULL AND c."id" IS NULL;
  SELECT COUNT(*) INTO dangling_staff
  FROM "appointments" a LEFT JOIN "staff" s ON s."id" = a."staffId"
  WHERE a."staffId" IS NOT NULL AND s."id" IS NULL;
  SELECT COUNT(*) INTO dangling_services
  FROM "appointmentServices" l LEFT JOIN "services" s ON s."id" = l."serviceId"
  WHERE l."serviceId" IS NOT NULL AND s."id" IS NULL;

  IF dangling_customers > 0 OR dangling_staff > 0 OR dangling_services > 0 THEN
    RAISE EXCEPTION 'dangling references exist (customers: %, technicians: %, services: %); resolve them before adding the foreign keys',
      dangling_customers, dangling_staff, dangling_services;
  END IF;

  SELECT COUNT(*) INTO orphan_lines FROM "appointmentServices" WHERE "appointmentId" IS NULL;
  IF orphan_lines > 0 THEN
    RAISE NOTICE '% appointmentServices rows already have no appointment; they are left as they are', orphan_lines;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'appointments_customer_fk') THEN
    ALTER TABLE "appointments"
      ADD CONSTRAINT appointments_customer_fk
      FOREIGN KEY ("customerId") REFERENCES "customers" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'appointments_staff_fk') THEN
    ALTER TABLE "appointments"
      ADD CONSTRAINT appointments_staff_fk
      FOREIGN KEY ("staffId") REFERENCES "staff" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'appointment_services_service_fk') THEN
    ALTER TABLE "appointmentServices"
      ADD CONSTRAINT appointment_services_service_fk
      FOREIGN KEY ("serviceId") REFERENCES "services" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- Detaching a booked service from its appointment deletes it. The trigger removes the row and cancels the UPDATE.
CREATE OR REPLACE FUNCTION appointment_services_delete_when_detached() RETURNS TRIGGER AS $$
BEGIN
  DELETE FROM "appointmentServices" WHERE "id" = OLD."id";
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS appointment_services_detach ON "appointmentServices";
CREATE TRIGGER appointment_services_detach
  BEFORE UPDATE OF "appointmentId" ON "appointmentServices"
  FOR EACH ROW
  WHEN (OLD."appointmentId" IS NOT NULL AND NEW."appointmentId" IS NULL)
  EXECUTE FUNCTION appointment_services_delete_when_detached();

COMMIT;
