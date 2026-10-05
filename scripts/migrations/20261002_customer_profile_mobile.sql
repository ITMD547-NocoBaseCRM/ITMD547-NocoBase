BEGIN;

-- T-09: keep the native profile layout single-column and comfortable on narrow
-- screens while preserving the same grid structure on tablet and desktop.
UPDATE "uiSchemas"
SET "schema" = jsonb_set(
  "schema"::jsonb,
  '{x-component-props}',
  COALESCE("schema"::jsonb->'x-component-props', '{}'::jsonb) || '{"rowGap":12,"colGap":12}'::jsonb,
  TRUE
)::json
WHERE "x-uid" IN ('frjjlv3hp1b', 'rrg040q4ou0');

-- Long contact/address values must wrap inside the drawer instead of forcing
-- page width. Notes keep their existing expandable multi-line treatment.
UPDATE "uiSchemas"
SET "schema" = jsonb_set(
  "schema"::jsonb,
  '{x-component-props}',
  COALESCE("schema"::jsonb->'x-component-props', '{}'::jsonb) || '{"style":{"overflowWrap":"anywhere","wordBreak":"break-word"}}'::jsonb,
  TRUE
)::json
WHERE "x-uid" IN ('ou37uqsdwd3', 'hva89pdwbsu', 'vxff12u0p89', '27d5epa9abi');

UPDATE "uiSchemas"
SET "schema" = jsonb_set(
  "schema"::jsonb,
  '{x-component-props}',
  COALESCE("schema"::jsonb->'x-component-props', '{}'::jsonb) || '{"style":{"minHeight":44,"display":"inline-flex","alignItems":"center","paddingInline":4}}'::jsonb,
  TRUE
)::json
WHERE "x-uid" = 't04backaction';

COMMIT;
