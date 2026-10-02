BEGIN;

-- T-01: extend the existing customers collection without rewriting customer data.
ALTER TABLE "customers"
  ADD COLUMN IF NOT EXISTS "skinProfile" VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "skinProfileOther" TEXT,
  ADD COLUMN IF NOT EXISTS "skinSensitivities" TEXT[],
  ADD COLUMN IF NOT EXISTS "skinSensitivitiesOther" TEXT;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'customers'
      AND column_name = 'skinSensitivities'
      AND (data_type <> 'ARRAY' OR udt_name <> '_text')
  ) THEN
    RAISE EXCEPTION 'customers.skinSensitivities must remain a PostgreSQL text[] column';
  END IF;
END $$;

-- Keep NocoBase collection metadata aligned with the physical columns.
UPDATE "fields"
SET "type" = 'string',
    "interface" = 'select',
    "description" = 'Optional skin profile',
    "options" = '{
      "enum": [
        {"value":"normal","label":"Normal","color":"default"},
        {"value":"dry","label":"Dry","color":"gold"},
        {"value":"oily","label":"Oily","color":"blue"},
        {"value":"combination","label":"Combination","color":"purple"},
        {"value":"sensitive","label":"Sensitive","color":"orange"},
        {"value":"other","label":"Other","color":"default"}
      ],
      "uiSchema": {
        "type":"string",
        "title":"Skin profile",
        "x-component":"Select",
        "enum": [
          {"value":"normal","label":"Normal","color":"default"},
          {"value":"dry","label":"Dry","color":"gold"},
          {"value":"oily","label":"Oily","color":"blue"},
          {"value":"combination","label":"Combination","color":"purple"},
          {"value":"sensitive","label":"Sensitive","color":"orange"},
          {"value":"other","label":"Other","color":"default"}
        ]
      }
    }'::json
WHERE "collectionName" = 'customers' AND "name" = 'skinProfile';

INSERT INTO "fields" ("key", "name", "type", "interface", "description", "collectionName", "options", "sort")
SELECT 'customer_skin_profile', 'skinProfile', 'string', 'select', 'Optional skin profile', 'customers',
  '{
    "enum": [
      {"value":"normal","label":"Normal","color":"default"},
      {"value":"dry","label":"Dry","color":"gold"},
      {"value":"oily","label":"Oily","color":"blue"},
      {"value":"combination","label":"Combination","color":"purple"},
      {"value":"sensitive","label":"Sensitive","color":"orange"},
      {"value":"other","label":"Other","color":"default"}
    ],
    "uiSchema": {
      "type":"string",
      "title":"Skin profile",
      "x-component":"Select",
      "enum": [
        {"value":"normal","label":"Normal","color":"default"},
        {"value":"dry","label":"Dry","color":"gold"},
        {"value":"oily","label":"Oily","color":"blue"},
        {"value":"combination","label":"Combination","color":"purple"},
        {"value":"sensitive","label":"Sensitive","color":"orange"},
        {"value":"other","label":"Other","color":"default"}
      ]
    }
  }'::json,
  COALESCE((SELECT MAX("sort") FROM "fields" WHERE "collectionName" = 'customers'), 0) + 1
WHERE NOT EXISTS (
  SELECT 1 FROM "fields" WHERE "collectionName" = 'customers' AND "name" = 'skinProfile'
);

UPDATE "fields"
SET "type" = 'text',
    "interface" = 'textarea',
    "description" = 'Optional explanation when skin profile is Other',
    "options" = '{"uiSchema":{"type":"string","title":"Skin profile (Other)","x-component":"Input.TextArea"}}'::json
WHERE "collectionName" = 'customers' AND "name" = 'skinProfileOther';

INSERT INTO "fields" ("key", "name", "type", "interface", "description", "collectionName", "options", "sort")
SELECT 'customer_skin_profile_other', 'skinProfileOther', 'text', 'textarea', 'Optional explanation when skin profile is Other', 'customers',
  '{"uiSchema":{"type":"string","title":"Skin profile (Other)","x-component":"Input.TextArea"}}'::json,
  COALESCE((SELECT MAX("sort") FROM "fields" WHERE "collectionName" = 'customers'), 0) + 1
WHERE NOT EXISTS (
  SELECT 1 FROM "fields" WHERE "collectionName" = 'customers' AND "name" = 'skinProfileOther'
);

UPDATE "fields"
SET "type" = 'array',
    "interface" = 'multipleSelect',
    "description" = 'Optional skin sensitivities; stored as a PostgreSQL text array',
    "options" = '{
      "dataType":"array",
      "elementType":"string",
      "defaultValue":[],
      "enum": [
        {"value":"fragrancesPerfumes","label":"Fragrances & Perfumes","color":"purple"},
        {"value":"essentialOils","label":"Essential Oils","color":"green"},
        {"value":"alphaHydroxyAcids","label":"Alpha Hydroxy Acids (AHAs)","color":"orange"},
        {"value":"betaHydroxyAcidsSalicylicAcid","label":"Beta Hydroxy Acids (BHAs) / Salicylic Acid","color":"gold"},
        {"value":"retinoidsRetinol","label":"Retinoids / Retinol","color":"red"},
        {"value":"latex","label":"Latex","color":"default"},
        {"value":"nutsSeedOils","label":"Nuts & Seed Oils","color":"blue"},
        {"value":"sunExposureSunburn","label":"Sun Exposure / Sunburn","color":"volcano"},
        {"value":"other","label":"Other","color":"default"}
      ],
      "uiSchema": {
        "type":"array",
        "title":"Skin sensitivities",
        "x-component":"Select",
        "x-component-props":{"mode":"multiple"},
        "enum": [
          {"value":"fragrancesPerfumes","label":"Fragrances & Perfumes","color":"purple"},
          {"value":"essentialOils","label":"Essential Oils","color":"green"},
          {"value":"alphaHydroxyAcids","label":"Alpha Hydroxy Acids (AHAs)","color":"orange"},
          {"value":"betaHydroxyAcidsSalicylicAcid","label":"Beta Hydroxy Acids (BHAs) / Salicylic Acid","color":"gold"},
          {"value":"retinoidsRetinol","label":"Retinoids / Retinol","color":"red"},
          {"value":"latex","label":"Latex","color":"default"},
          {"value":"nutsSeedOils","label":"Nuts & Seed Oils","color":"blue"},
          {"value":"sunExposureSunburn","label":"Sun Exposure / Sunburn","color":"volcano"},
          {"value":"other","label":"Other","color":"default"}
        ]
      }
    }'::json
WHERE "collectionName" = 'customers' AND "name" = 'skinSensitivities';

INSERT INTO "fields" ("key", "name", "type", "interface", "description", "collectionName", "options", "sort")
SELECT 'customer_skin_sensitivities', 'skinSensitivities', 'array', 'multipleSelect', 'Optional skin sensitivities; stored as a PostgreSQL text array', 'customers',
  '{
    "dataType":"array",
    "elementType":"string",
    "defaultValue":[],
    "enum": [
      {"value":"fragrancesPerfumes","label":"Fragrances & Perfumes","color":"purple"},
      {"value":"essentialOils","label":"Essential Oils","color":"green"},
      {"value":"alphaHydroxyAcids","label":"Alpha Hydroxy Acids (AHAs)","color":"orange"},
      {"value":"betaHydroxyAcidsSalicylicAcid","label":"Beta Hydroxy Acids (BHAs) / Salicylic Acid","color":"gold"},
      {"value":"retinoidsRetinol","label":"Retinoids / Retinol","color":"red"},
      {"value":"latex","label":"Latex","color":"default"},
      {"value":"nutsSeedOils","label":"Nuts & Seed Oils","color":"blue"},
      {"value":"sunExposureSunburn","label":"Sun Exposure / Sunburn","color":"volcano"},
      {"value":"other","label":"Other","color":"default"}
    ],
    "uiSchema": {
      "type":"array",
      "title":"Skin sensitivities",
      "x-component":"Select",
      "x-component-props":{"mode":"multiple"},
      "enum": [
        {"value":"fragrancesPerfumes","label":"Fragrances & Perfumes","color":"purple"},
        {"value":"essentialOils","label":"Essential Oils","color":"green"},
        {"value":"alphaHydroxyAcids","label":"Alpha Hydroxy Acids (AHAs)","color":"orange"},
        {"value":"betaHydroxyAcidsSalicylicAcid","label":"Beta Hydroxy Acids (BHAs) / Salicylic Acid","color":"gold"},
        {"value":"retinoidsRetinol","label":"Retinoids / Retinol","color":"red"},
        {"value":"latex","label":"Latex","color":"default"},
        {"value":"nutsSeedOils","label":"Nuts & Seed Oils","color":"blue"},
        {"value":"sunExposureSunburn","label":"Sun Exposure / Sunburn","color":"volcano"},
        {"value":"other","label":"Other","color":"default"}
      ]
    }
  }'::json,
  COALESCE((SELECT MAX("sort") FROM "fields" WHERE "collectionName" = 'customers'), 0) + 1
WHERE NOT EXISTS (
  SELECT 1 FROM "fields" WHERE "collectionName" = 'customers' AND "name" = 'skinSensitivities'
);

UPDATE "fields"
SET "type" = 'text',
    "interface" = 'textarea',
    "description" = 'Optional explanation when skin sensitivities includes Other',
    "options" = '{"uiSchema":{"type":"string","title":"Skin sensitivities (Other)","x-component":"Input.TextArea"}}'::json
WHERE "collectionName" = 'customers' AND "name" = 'skinSensitivitiesOther';

INSERT INTO "fields" ("key", "name", "type", "interface", "description", "collectionName", "options", "sort")
SELECT 'customer_skin_sensitivities_other', 'skinSensitivitiesOther', 'text', 'textarea', 'Optional explanation when skin sensitivities includes Other', 'customers',
  '{"uiSchema":{"type":"string","title":"Skin sensitivities (Other)","x-component":"Input.TextArea"}}'::json,
  COALESCE((SELECT MAX("sort") FROM "fields" WHERE "collectionName" = 'customers'), 0) + 1
WHERE NOT EXISTS (
  SELECT 1 FROM "fields" WHERE "collectionName" = 'customers' AND "name" = 'skinSensitivitiesOther'
);

COMMIT;
