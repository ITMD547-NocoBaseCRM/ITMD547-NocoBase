BEGIN;

-- T-04: extend the existing customer view drawer with a scannable profile and
-- a customer-scoped service-history table. All values are resolved at runtime
-- from the selected record; no customer is embedded in this schema.

CREATE OR REPLACE FUNCTION add_customer_profile_ui_node(
  p_uid TEXT,
  p_name TEXT,
  p_parent TEXT,
  p_schema JSONB
) RETURNS VOID AS $$
BEGIN
  INSERT INTO "uiSchemas" ("x-uid", "name", "schema")
  VALUES (p_uid, p_name, p_schema::json)
  ON CONFLICT ("x-uid") DO UPDATE SET "name" = EXCLUDED."name", "schema" = EXCLUDED."schema";

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

-- Existing detail fields use the same neutral empty value and keep long notes
-- readable without exposing internal IDs.
UPDATE "uiSchemas"
SET "schema" = jsonb_set(
  jsonb_set("schema"::jsonb, '{x-component-props}', COALESCE("schema"::jsonb->'x-component-props', '{}'::jsonb) || '{"emptyText":"Not provided"}'::jsonb, TRUE),
  '{x-component-props,ellipsis}', '{"rows":4,"expandable":true}'::jsonb, TRUE
)::json
WHERE "x-uid" = '27d5epa9abi';

UPDATE "uiSchemas"
SET "schema" = jsonb_set(
  "schema"::jsonb, '{x-component-props}', COALESCE("schema"::jsonb->'x-component-props', '{}'::jsonb) || '{"emptyText":"Not provided"}'::jsonb, TRUE
)::json
WHERE "x-uid" IN ('iqehi8fg7of','oi1g0gn0s9t','ou37uqsdwd3','hva89pdwbsu','0px6igr6mqn','vxff12u0p89','rjq4f8fmcl7');

-- Keep the navigation intent visible inside the drawer as well as in the
-- drawer's native close affordance.
SELECT add_customer_profile_ui_node('t04backrow', 'backToCustomers', 'frjjlv3hp1b', '{
  "type":"void", "x-component":"Grid.Row",
  "properties": {"t04backcol": {"type":"void", "x-component":"Grid.Col"}}
}'::jsonb);
SELECT add_customer_profile_ui_node('t04backcol', 'backToCustomers', 't04backrow', '{"type":"void", "x-component":"Grid.Col"}'::jsonb);
SELECT add_customer_profile_ui_node('t04backaction', 'backToCustomers', 't04backcol', '{
  "type":"void", "title":"Back to Customers", "x-action":"close",
  "x-component":"Action.Link", "x-component-props":{"icon":"ArrowLeftOutlined"},
  "x-align":"left"
}'::jsonb);

-- Skin profile and sensitivity fields live inside the existing customer
-- Details block. The sensitivity empty state is deliberately explicit: an
-- empty database value means unrecorded, not that the customer has none.
SELECT add_customer_profile_ui_node('t04skinprofile', 'skinProfile', 'rrg040q4ou0', '{
  "type":"void", "x-component":"Grid.Row",
  "properties": {"t04skinprofilecol": {"type":"void", "x-component":"Grid.Col"}}
}'::jsonb);
SELECT add_customer_profile_ui_node('t04skinprofilecol', 'skinProfile', 't04skinprofile', '{"type":"void", "x-component":"Grid.Col"}'::jsonb);
SELECT add_customer_profile_ui_node('t04skinprofilefield', 'skinProfile', 't04skinprofilecol', '{
  "type":"string", "x-toolbar":"FormItemSchemaToolbar", "x-settings":"fieldSettings:FormItem",
  "x-component":"CollectionField", "x-decorator":"FormItem", "x-collection-field":"customers.skinProfile",
  "x-component-props":{"emptyText":"Not provided"}, "x-read-pretty":true
}'::jsonb);

SELECT add_customer_profile_ui_node('t04skinprofileother', 'skinProfileOther', 'rrg040q4ou0', '{
  "type":"void", "x-component":"Grid.Row",
  "properties": {"t04skinprofileothercol": {"type":"void", "x-component":"Grid.Col"}}
}'::jsonb);
SELECT add_customer_profile_ui_node('t04skinprofileothercol', 'skinProfileOther', 't04skinprofileother', '{"type":"void", "x-component":"Grid.Col"}'::jsonb);
SELECT add_customer_profile_ui_node('t04skinprofileotherfield', 'skinProfileOther', 't04skinprofileothercol', '{
  "type":"string", "x-toolbar":"FormItemSchemaToolbar", "x-settings":"fieldSettings:FormItem",
  "x-component":"CollectionField", "x-decorator":"FormItem", "x-collection-field":"customers.skinProfileOther",
  "x-component-props":{"emptyText":"Not provided"}, "x-read-pretty":true
}'::jsonb);

SELECT add_customer_profile_ui_node('t04sensitivities', 'skinSensitivities', 'rrg040q4ou0', '{
  "type":"void", "x-component":"Grid.Row",
  "properties": {"t04sensitivitiescol": {"type":"void", "x-component":"Grid.Col"}}
}'::jsonb);
SELECT add_customer_profile_ui_node('t04sensitivitiescol', 'skinSensitivities', 't04sensitivities', '{"type":"void", "x-component":"Grid.Col"}'::jsonb);
SELECT add_customer_profile_ui_node('t04sensitivitiesfield', 'skinSensitivities', 't04sensitivitiescol', '{
  "type":"array", "x-toolbar":"FormItemSchemaToolbar", "x-settings":"fieldSettings:FormItem",
  "x-component":"CollectionField", "x-decorator":"FormItem", "x-collection-field":"customers.skinSensitivities",
  "x-component-props":{"emptyText":"No sensitivities recorded","mode":"tags"}, "x-read-pretty":true
}'::jsonb);

SELECT add_customer_profile_ui_node('t04sensitivitiesother', 'skinSensitivitiesOther', 'rrg040q4ou0', '{
  "type":"void", "x-component":"Grid.Row",
  "properties": {"t04sensitivitiesothercol": {"type":"void", "x-component":"Grid.Col"}}
}'::jsonb);
SELECT add_customer_profile_ui_node('t04sensitivitiesothercol', 'skinSensitivitiesOther', 't04sensitivitiesother', '{"type":"void", "x-component":"Grid.Col"}'::jsonb);
SELECT add_customer_profile_ui_node('t04sensitivitiesotherfield', 'skinSensitivitiesOther', 't04sensitivitiesothercol', '{
  "type":"string", "x-toolbar":"FormItemSchemaToolbar", "x-settings":"fieldSettings:FormItem",
  "x-component":"CollectionField", "x-decorator":"FormItem", "x-collection-field":"customers.skinSensitivitiesOther",
  "x-component-props":{"emptyText":"Not provided"}, "x-read-pretty":true
}'::jsonb);

-- Service history is a native table block in the same drawer. The filter is
-- evaluated with the popup's current customer record, while the sort remains
-- newest first. Service, date, provider, status, and notes all come from the
-- existing appointment-services model.
SELECT add_customer_profile_ui_node('t04historyrow', 'serviceHistory', 'frjjlv3hp1b', '{
  "type":"void", "x-component":"Grid.Row",
  "properties": {"t04historycol": {"type":"void", "x-component":"Grid.Col"}}
}'::jsonb);
SELECT add_customer_profile_ui_node('t04historycol', 'serviceHistory', 't04historyrow', '{"type":"void", "x-component":"Grid.Col"}'::jsonb);
SELECT add_customer_profile_ui_node('t04historyblock', 'serviceHistory', 't04historycol', '{
  "type":"void", "title":"Service history", "x-acl-action":"appointmentServices:list",
  "x-decorator":"TableBlockProvider", "x-use-decorator-props":"useTableBlockDecoratorProps",
  "x-decorator-props": {
    "collection":"appointmentServices", "dataSource":"main", "action":"list",
    "params": {
      "pageSize":20, "sort":["-appointment.appointmentDate","-createdAt"],
      "filter":{"appointment.customerId":{"$eq":"{{ $nRecord.id }}"}}
    },
    "showIndex":false, "dragSort":false
  },
  "x-toolbar":"BlockSchemaToolbar", "x-settings":"blockSettings:table",
  "x-component":"CardItem", "x-filter-targets":[]
}'::jsonb);
SELECT add_customer_profile_ui_node('t04historytable', 'serviceHistory', 't04historyblock', '{
  "type":"array", "x-initializer":"table:configureColumns", "x-component":"TableV2",
  "x-use-component-props":"useTableBlockProps", "x-component-props":{"rowKey":"id"},
  "properties": {
    "t04servicecol": {"type":"void", "x-decorator":"TableV2.Column.Decorator", "x-toolbar":"TableColumnSchemaToolbar", "x-settings":"fieldSettings:TableColumn", "x-component":"TableV2.Column", "properties":{"service":{"x-collection-field":"appointmentServices.service","x-component":"CollectionField","x-component-props":{"ellipsis":true},"x-read-pretty":true,"x-decorator":null}}},
    "t04datecol": {"type":"void", "x-decorator":"TableV2.Column.Decorator", "x-toolbar":"TableColumnSchemaToolbar", "x-settings":"fieldSettings:TableColumn", "x-component":"TableV2.Column", "properties":{"date":{"x-collection-field":"appointmentServices.appointment.appointmentDate","x-component":"CollectionField","x-component-props":{"ellipsis":true},"x-read-pretty":true,"x-decorator":null}}},
    "t04staffcol": {"type":"void", "x-decorator":"TableV2.Column.Decorator", "x-toolbar":"TableColumnSchemaToolbar", "x-settings":"fieldSettings:TableColumn", "x-component":"TableV2.Column", "properties":{"staff":{"x-collection-field":"appointmentServices.appointment.staff","x-component":"CollectionField","x-component-props":{"ellipsis":true},"x-read-pretty":true,"x-decorator":null}}},
    "t04statuscol": {"type":"void", "x-decorator":"TableV2.Column.Decorator", "x-toolbar":"TableColumnSchemaToolbar", "x-settings":"fieldSettings:TableColumn", "x-component":"TableV2.Column", "properties":{"status":{"x-collection-field":"appointmentServices.appointment.status","x-component":"CollectionField","x-component-props":{"ellipsis":true},"x-read-pretty":true,"x-decorator":null}}},
    "t04notescol": {"type":"void", "x-decorator":"TableV2.Column.Decorator", "x-toolbar":"TableColumnSchemaToolbar", "x-settings":"fieldSettings:TableColumn", "x-component":"TableV2.Column", "properties":{"notes":{"x-collection-field":"appointmentServices.notes","x-component":"CollectionField","x-component-props":{"ellipsis":true},"x-read-pretty":true,"x-decorator":null}}
    }
  }
}'::jsonb);

UPDATE "uiSchemas"
SET "schema" = jsonb_set("schema"::jsonb, '{title}', '"Customer profile"'::jsonb, TRUE)::json
WHERE "x-uid" = 'smp07c4lvlj';

DROP FUNCTION add_customer_profile_ui_node(TEXT, TEXT, TEXT, JSONB);
COMMIT;
