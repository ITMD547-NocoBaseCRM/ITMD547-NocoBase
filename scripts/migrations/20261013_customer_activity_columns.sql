BEGIN;

-- Customer activity, part 2: sortable activity columns on "customers".
--
-- Part 1 (20261013_customer_activity.sql) created the live view "customerActivity" and registered it in NocoBase as
-- customers.activity. Filtering the Customers table through that relation works, but sorting through it does not:
-- NocoBase 2.2 builds ORDER BY for an association without its alias and Sequelize rejects that for every named
-- relation. "Most active first" and "most recent visit first" therefore need real columns on the customers table.
--
-- This migration adds them and keeps them correct:
--   * columns: firstVisitAt, lastVisitAt, totalSpent, visitsLast1m .. visitsLast6m, visitsLast12m, activityRefreshedAt
--     (visitCount already exists and is kept in the same way);
--   * customers_refresh_activity(ids) copies the values from the view for the given customers (all when NULL);
--   * triggers on appointments and payments refresh the customers a change touches, immediately;
--   * the rolling counts also move with the calendar, so a daily refresh of every customer is needed:
--     the NocoBase scheduled workflow "Refresh customer activity" (created by yarn apply:customer-activity) runs
--     SELECT customers_refresh_activity() every night. Until it has run, counts are at most one day old.
--
-- The view stays the single definition of the numbers; the columns are a cache of it.
-- Idempotent. Run with `yarn migrate:customer-activity` (it applies part 1, then this file).

ALTER TABLE "customers"
  ADD COLUMN IF NOT EXISTS "firstVisitAt"        timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "lastVisitAt"         timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "totalSpent"          numeric(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "visitsLast1m"        integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "visitsLast2m"        integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "visitsLast3m"        integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "visitsLast4m"        integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "visitsLast5m"        integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "visitsLast6m"        integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "visitsLast12m"       integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "activityRefreshedAt" timestamp with time zone;

CREATE INDEX IF NOT EXISTS "customers_last_visit_idx" ON "customers" ("lastVisitAt");
CREATE INDEX IF NOT EXISTS "customers_first_visit_idx" ON "customers" ("firstVisitAt");

-- Copies the view's values onto the customers rows. NULL = every customer (the nightly refresh).
-- Only rows whose values changed are written, so the nightly run touches few rows on a quiet day.
CREATE OR REPLACE FUNCTION customers_refresh_activity(customer_ids BIGINT[] DEFAULT NULL) RETURNS INTEGER AS $$
DECLARE
  changed INTEGER;
BEGIN
  UPDATE "customers" c
  SET "visitCount"          = v."totalVisits",
      "firstVisitAt"        = v."firstVisitAt",
      "lastVisitAt"         = v."lastVisitAt",
      "totalSpent"          = v."totalSpent",
      "visitsLast1m"        = v."visitsLast1m",
      "visitsLast2m"        = v."visitsLast2m",
      "visitsLast3m"        = v."visitsLast3m",
      "visitsLast4m"        = v."visitsLast4m",
      "visitsLast5m"        = v."visitsLast5m",
      "visitsLast6m"        = v."visitsLast6m",
      "visitsLast12m"       = v."visitsLast12m",
      "activityRefreshedAt" = now()
  FROM "customerActivity" v
  WHERE v.id = c.id
    AND (customer_ids IS NULL OR c.id = ANY(customer_ids))
    AND (
      c."visitCount"    IS DISTINCT FROM v."totalVisits"  OR
      c."firstVisitAt"  IS DISTINCT FROM v."firstVisitAt" OR
      c."lastVisitAt"   IS DISTINCT FROM v."lastVisitAt"  OR
      c."totalSpent"    IS DISTINCT FROM v."totalSpent"   OR
      c."visitsLast1m"  IS DISTINCT FROM v."visitsLast1m" OR
      c."visitsLast2m"  IS DISTINCT FROM v."visitsLast2m" OR
      c."visitsLast3m"  IS DISTINCT FROM v."visitsLast3m" OR
      c."visitsLast4m"  IS DISTINCT FROM v."visitsLast4m" OR
      c."visitsLast5m"  IS DISTINCT FROM v."visitsLast5m" OR
      c."visitsLast6m"  IS DISTINCT FROM v."visitsLast6m" OR
      c."visitsLast12m" IS DISTINCT FROM v."visitsLast12m" OR
      c."activityRefreshedAt" IS NULL
    );
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed;
END;
$$ LANGUAGE plpgsql;

-- Part 1's visitCount-only sync is superseded: the same trigger now refreshes every activity column.
CREATE OR REPLACE FUNCTION customers_sync_visit_count(customer_ids BIGINT[]) RETURNS VOID AS $$
BEGIN
  PERFORM customers_refresh_activity(customer_ids);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION customers_refresh_activity_from_change() RETURNS TRIGGER AS $$
DECLARE
  ids BIGINT[] := ARRAY[]::BIGINT[];
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD."customerId" IS NOT NULL THEN
    ids := array_append(ids, OLD."customerId");
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW."customerId" IS NOT NULL AND NOT (NEW."customerId" = ANY(ids)) THEN
    ids := array_append(ids, NEW."customerId");
  END IF;
  IF array_length(ids, 1) IS NOT NULL THEN
    PERFORM customers_refresh_activity(ids);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS appointments_sync_customer_visit_count ON "appointments";
DROP TRIGGER IF EXISTS appointments_refresh_customer_activity ON "appointments";
CREATE TRIGGER appointments_refresh_customer_activity
  AFTER INSERT OR DELETE OR UPDATE OF status, "customerId", "startTime" ON "appointments"
  FOR EACH ROW
  EXECUTE FUNCTION customers_refresh_activity_from_change();

DROP TRIGGER IF EXISTS payments_refresh_customer_activity ON "payments";
CREATE TRIGGER payments_refresh_customer_activity
  AFTER INSERT OR DELETE OR UPDATE OF status, amount, "customerId", "paymentDate" ON "payments"
  FOR EACH ROW
  EXECUTE FUNCTION customers_refresh_activity_from_change();

-- Backfill every customer now.
DO $$
DECLARE
  changed INTEGER;
BEGIN
  SELECT customers_refresh_activity(NULL) INTO changed;
  RAISE NOTICE 'activity columns refreshed on % customer(s)', changed;
END $$;

COMMIT;
