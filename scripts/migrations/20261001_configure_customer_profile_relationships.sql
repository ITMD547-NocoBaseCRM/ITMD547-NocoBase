BEGIN;

-- T-02 reuses the existing customer -> appointment -> appointment service -> service model.
-- Fail safely if the live NocoBase relationship metadata has drifted.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "fields"
    WHERE "collectionName" = 'customers'
      AND "name" = 'appointments'
      AND "type" = 'hasMany'
      AND "interface" = 'o2m'
      AND "options"->>'target' = 'appointments'
      AND "options"->>'foreignKey' = 'customerId'
      AND "options"->>'sourceKey' = 'id'
  ) THEN
    RAISE EXCEPTION 'Expected customers.appointments relationship is missing or misconfigured';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "fields"
    WHERE "collectionName" = 'appointments'
      AND "name" = 'customer'
      AND "type" = 'belongsTo'
      AND "interface" = 'm2o'
      AND "options"->>'target' = 'customers'
      AND "options"->>'foreignKey' = 'customerId'
      AND "options"->>'targetKey' = 'id'
  ) THEN
    RAISE EXCEPTION 'Expected appointments.customer relationship is missing or misconfigured';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "fields"
    WHERE "collectionName" = 'appointments'
      AND "name" = 'appointmentServices'
      AND "type" = 'hasMany'
      AND "interface" = 'o2m'
      AND "options"->>'target' = 'appointmentServices'
      AND "options"->>'foreignKey' = 'appointmentId'
      AND "options"->>'sourceKey' = 'id'
  ) THEN
    RAISE EXCEPTION 'Expected appointments.appointmentServices relationship is missing or misconfigured';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "fields"
    WHERE "collectionName" = 'appointmentServices'
      AND "name" = 'appointment'
      AND "type" = 'belongsTo'
      AND "interface" = 'm2o'
      AND "options"->>'target' = 'appointments'
      AND "options"->>'foreignKey' = 'appointmentId'
      AND "options"->>'targetKey' = 'id'
  ) THEN
    RAISE EXCEPTION 'Expected appointmentServices.appointment relationship is missing or misconfigured';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "fields"
    WHERE "collectionName" = 'appointmentServices'
      AND "name" = 'service'
      AND "type" = 'belongsTo'
      AND "interface" = 'm2o'
      AND "options"->>'target' = 'services'
      AND "options"->>'foreignKey' = 'serviceId'
      AND "options"->>'targetKey' = 'id'
  ) THEN
    RAISE EXCEPTION 'Expected appointmentServices.service relationship is missing or misconfigured';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "fields"
    WHERE "collectionName" = 'appointments'
      AND "name" = 'staff'
      AND "type" = 'belongsTo'
      AND "interface" = 'm2o'
      AND "options"->>'target' = 'staff'
      AND "options"->>'foreignKey' = 'staffId'
      AND "options"->>'targetKey' = 'id'
  ) THEN
    RAISE EXCEPTION 'Expected appointments.staff relationship is missing or misconfigured';
  END IF;
END $$;

-- Supports profile history queries filtered by customer/status and ordered by date.
CREATE INDEX IF NOT EXISTS appointments_customer_history
  ON "appointments" ("customerId", "status", "appointmentDate" DESC);

COMMIT;
