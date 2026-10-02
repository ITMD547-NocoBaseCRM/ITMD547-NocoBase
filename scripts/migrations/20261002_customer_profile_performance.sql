BEGIN;

-- T-08: keep the first mobile directory/profile requests small and limited to
-- fields rendered by their native table blocks. Pagination remains available
-- for larger lists.
UPDATE "uiSchemas"
SET "schema" = jsonb_set(
  "schema"::jsonb,
  '{x-decorator-props,params}',
  COALESCE(("schema"::jsonb #> '{x-decorator-props,params}'), '{}'::jsonb) || '{
    "pageSize":10,
    "fields":["id","firstName","lastName","phone","status"]
  }'::jsonb,
  TRUE
)::json
WHERE "x-uid" = 'hf6ddg90ato';

-- Service history is the largest profile-related list and is loaded inside a
-- paginated native table. Request only the rendered fields/relations initially.
UPDATE "uiSchemas"
SET "schema" = jsonb_set(
  "schema"::jsonb,
  '{x-decorator-props,params}',
  COALESCE(("schema"::jsonb #> '{x-decorator-props,params}'), '{}'::jsonb) || '{
    "pageSize":10,
    "fields":["id","notes","appointmentId","serviceId"],
    "appends":["service","appointment","appointment.staff"]
  }'::jsonb,
  TRUE
)::json
WHERE "x-uid" = 't04historyblock';

COMMIT;
