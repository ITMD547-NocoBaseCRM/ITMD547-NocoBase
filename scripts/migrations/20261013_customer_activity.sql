BEGIN;

-- Customer activity filters: inactive for N months, most active, new, one-time, repeat, high-value, at-risk, never visited.
--
-- Everything is derived from the appointments a customer has actually completed (status = 'completed') and from
-- their payments, so nothing is copied onto the customer and nothing can drift. Two pieces:
--
--   1. The view "customerActivity": one row per customer with first/last completed visit, total visits, rolling
--      visit counts for the last 1..6 and 12 months, and net spending. A view is computed when it is read, so
--      "last 3 months" is always relative to today without a scheduled job. NocoBase registers it as a read-only
--      view collection and the customers collection gets a hasOne "activity" relation to it
--      (yarn apply:customer-activity), so the Customers table can be filtered and sorted by it server-side.
--
--   2. customers."visitCount" (the "Visits" column that already exists on the Customers page) is kept equal to the
--      number of completed appointments by a trigger, instead of being typed in. Existing rows are backfilled.
--
-- Rules
--   * A visit is an appointment with status 'completed'. Scheduled, confirmed, in-progress, cancelled and no-show
--     appointments are never visits. The visit time is the appointment's startTime.
--   * Net spending is the sum of payments with status 'paid' plus 'refunded' rows (refunds are stored as negative
--     amounts). Pending and failed payments are not spending.
--   * Rolling windows are measured from now(): "last 3 months" = startTime >= now() - interval '3 months'.
--
-- Idempotent. Run with `yarn migrate:customer-activity`.

CREATE OR REPLACE VIEW "customerActivity" AS
WITH visits AS (
  SELECT
    a."customerId",
    COUNT(*)::integer                                                                   AS "totalVisits",
    MIN(a."startTime")                                                                  AS "firstVisitAt",
    MAX(a."startTime")                                                                  AS "lastVisitAt",
    COUNT(*) FILTER (WHERE a."startTime" >= now() - interval '1 month')::integer        AS "visitsLast1m",
    COUNT(*) FILTER (WHERE a."startTime" >= now() - interval '2 months')::integer       AS "visitsLast2m",
    COUNT(*) FILTER (WHERE a."startTime" >= now() - interval '3 months')::integer       AS "visitsLast3m",
    COUNT(*) FILTER (WHERE a."startTime" >= now() - interval '4 months')::integer       AS "visitsLast4m",
    COUNT(*) FILTER (WHERE a."startTime" >= now() - interval '5 months')::integer       AS "visitsLast5m",
    COUNT(*) FILTER (WHERE a."startTime" >= now() - interval '6 months')::integer       AS "visitsLast6m",
    COUNT(*) FILTER (WHERE a."startTime" >= now() - interval '12 months')::integer      AS "visitsLast12m"
  FROM "appointments" a
  WHERE a.status = 'completed'
  GROUP BY a."customerId"
),
spend AS (
  SELECT
    p."customerId",
    ROUND(COALESCE(SUM(p.amount), 0)::numeric, 2)                                       AS "totalSpent",
    ROUND(COALESCE(SUM(p.amount) FILTER (WHERE p."paymentDate" >= now() - interval '12 months'), 0)::numeric, 2) AS "spentLast12m"
  FROM "payments" p
  WHERE p.status IN ('paid', 'refunded') AND p."customerId" IS NOT NULL
  GROUP BY p."customerId"
)
SELECT
  c.id                                                                                   AS id,
  c.id                                                                                   AS "customerId",
  COALESCE(v."totalVisits", 0)                                                           AS "totalVisits",
  v."firstVisitAt",
  v."lastVisitAt",
  CASE WHEN v."lastVisitAt" IS NULL THEN NULL
       ELSE FLOOR(EXTRACT(EPOCH FROM (now() - v."lastVisitAt")) / 86400)::integer END    AS "daysSinceLastVisit",
  COALESCE(v."visitsLast1m", 0)                                                          AS "visitsLast1m",
  COALESCE(v."visitsLast2m", 0)                                                          AS "visitsLast2m",
  COALESCE(v."visitsLast3m", 0)                                                          AS "visitsLast3m",
  COALESCE(v."visitsLast4m", 0)                                                          AS "visitsLast4m",
  COALESCE(v."visitsLast5m", 0)                                                          AS "visitsLast5m",
  COALESCE(v."visitsLast6m", 0)                                                          AS "visitsLast6m",
  COALESCE(v."visitsLast12m", 0)                                                         AS "visitsLast12m",
  COALESCE(s."totalSpent", 0)                                                            AS "totalSpent",
  COALESCE(s."spentLast12m", 0)                                                          AS "spentLast12m"
FROM "customers" c
LEFT JOIN visits v ON v."customerId" = c.id
LEFT JOIN spend  s ON s."customerId" = c.id;

COMMENT ON VIEW "customerActivity" IS
  'One row per customer: completed-visit history and net spending, computed live. Registered in NocoBase as the read-only collection customerActivity (customers.activity).';

-- Indexes the view relies on. IF NOT EXISTS keeps re-runs cheap.
CREATE INDEX IF NOT EXISTS "appointments_customer_completed_start_idx"
  ON "appointments" ("customerId", "startTime") WHERE status = 'completed';
CREATE INDEX IF NOT EXISTS "payments_customer_status_idx"
  ON "payments" ("customerId", status);

-- ---------------------------------------------------------------------------
-- customers.visitCount = number of completed appointments, maintained by trigger.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION customers_sync_visit_count(customer_ids BIGINT[]) RETURNS VOID AS $$
BEGIN
  UPDATE "customers" c
  SET "visitCount" = sub.completed
  FROM (
    SELECT ids.id, COUNT(a.id) FILTER (WHERE a.status = 'completed')::integer AS completed
    FROM unnest(customer_ids) AS ids(id)
    LEFT JOIN "appointments" a ON a."customerId" = ids.id
    GROUP BY ids.id
  ) sub
  WHERE c.id = sub.id AND c."visitCount" IS DISTINCT FROM sub.completed;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION appointments_sync_customer_visit_count() RETURNS TRIGGER AS $$
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
    PERFORM customers_sync_visit_count(ids);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS appointments_sync_customer_visit_count ON "appointments";
CREATE TRIGGER appointments_sync_customer_visit_count
  AFTER INSERT OR DELETE OR UPDATE OF status, "customerId" ON "appointments"
  FOR EACH ROW
  EXECUTE FUNCTION appointments_sync_customer_visit_count();

-- Backfill: every customer's visitCount becomes the real number of completed appointments.
DO $$
DECLARE
  fixed INTEGER;
BEGIN
  SELECT COUNT(*) INTO fixed
  FROM "customers" c
  WHERE c."visitCount" IS DISTINCT FROM
        (SELECT COUNT(*)::integer FROM "appointments" a WHERE a."customerId" = c.id AND a.status = 'completed');
  PERFORM customers_sync_visit_count(ARRAY(SELECT id FROM "customers"));
  RAISE NOTICE 'visitCount corrected on % customer(s)', fixed;
END $$;

-- NocoBase metadata: the column is derived now, so it is shown read-only and described as such.
UPDATE "fields"
SET "options" = jsonb_set(
      jsonb_set("options"::jsonb, '{uiSchema,x-read-pretty}', 'true'::jsonb, TRUE),
      '{uiSchema,title}', '"Completed visits"'::jsonb, TRUE
    )::json,
    "description" = 'Number of completed appointments; kept up to date automatically'
WHERE "collectionName" = 'customers' AND "name" = 'visitCount';

COMMIT;
