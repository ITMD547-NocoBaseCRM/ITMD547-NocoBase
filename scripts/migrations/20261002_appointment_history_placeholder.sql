BEGIN;

-- T-05: reserve a stable, native profile section for future appointment
-- history. It deliberately has no collection provider, query, or fabricated
-- records; a future implementation can replace this card's content with an
-- appointment-history block without moving the customer profile layout.
CREATE OR REPLACE FUNCTION add_customer_appointment_placeholder_ui_node(
  p_uid TEXT,
  p_name TEXT,
  p_parent TEXT,
  p_schema JSONB
) RETURNS VOID AS $$
BEGIN
  INSERT INTO "uiSchemas" ("x-uid", "name", "schema")
  VALUES (p_uid, p_name, p_schema::json)
  ON CONFLICT ("x-uid") DO UPDATE
  SET "name" = EXCLUDED."name", "schema" = EXCLUDED."schema";

  INSERT INTO "uiSchemaTreePath" ("ancestor", "descendant", "depth", "async", "type", "sort")
  SELECT "ancestor", p_uid, "depth" + 1, NULL, NULL, NULL
  FROM "uiSchemaTreePath"
  WHERE "descendant" = p_parent
  ON CONFLICT ("ancestor", "descendant") DO NOTHING;

  INSERT INTO "uiSchemaTreePath" ("ancestor", "descendant", "depth", "async", "type", "sort")
  VALUES (p_uid, p_uid, 0, FALSE, NULL, NULL)
  ON CONFLICT ("ancestor", "descendant") DO NOTHING;
END;
$$ LANGUAGE plpgsql;

-- This card is intentionally placed after the existing service-history row.
-- The description is rendered by the native CardItem using existing design
-- tokens and remains neutral about whether appointments exist today.
SELECT add_customer_appointment_placeholder_ui_node(
  't05appointmentrow',
  'appointmentHistory',
  'frjjlv3hp1b',
  '{
    "type":"void",
    "x-component":"Grid.Row",
    "properties": {
      "t05appointmentcol": {"type":"void", "x-component":"Grid.Col"}
    }
  }'::jsonb
);

SELECT add_customer_appointment_placeholder_ui_node(
  't05appointmentcol',
  'appointmentHistory',
  't05appointmentrow',
  '{"type":"void", "x-component":"Grid.Col"}'::jsonb
);

SELECT add_customer_appointment_placeholder_ui_node(
  't05appointmentblock',
  'appointmentHistory',
  't05appointmentcol',
  '{
    "type":"void",
    "title":"Appointment history",
    "description":"Appointment history will appear here when appointment tracking is available.",
    "x-component":"CardItem",
    "x-component-props":{"className":"customer-appointment-history-placeholder"}
  }'::jsonb
);

DROP FUNCTION add_customer_appointment_placeholder_ui_node(TEXT, TEXT, TEXT, JSONB);
COMMIT;
