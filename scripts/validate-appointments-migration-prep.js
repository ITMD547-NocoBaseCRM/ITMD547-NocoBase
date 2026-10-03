const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

function loadEnv(filePath) {
  const values = {};
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match) values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return values;
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const env = loadEnv(path.resolve(process.cwd(), '.env'));
  const client = new Client({
    host: env.DB_HOST,
    port: Number(env.DB_PORT || 5432),
    database: env.DB_DATABASE,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    ssl: { rejectUnauthorized: env.DB_DIALECT_OPTIONS_SSL_REJECT_UNAUTHORIZED !== 'false' },
  });
  await client.connect();
  try {
    const columns = await client.query(
      `select column_name, is_nullable from information_schema.columns
       where table_schema = current_schema() and table_name = 'appointments'
         and column_name in ('externalSource', 'externalId')`,
    );
    expect(columns.rows.length === 2, 'externalSource/externalId columns are missing');
    expect(
      columns.rows.every((row) => row.is_nullable === 'YES'),
      'external identity columns must stay nullable for NocoBase-created appointments',
    );

    const index = await client.query(
      `select indexdef from pg_indexes where tablename = 'appointments' and indexname = 'appointments_external_identity'`,
    );
    expect(index.rows.length === 1, 'appointments_external_identity index is missing');
    expect(/UNIQUE INDEX/.test(index.rows[0].indexdef), 'appointments_external_identity must be unique');
    expect(/WHERE/.test(index.rows[0].indexdef), 'appointments_external_identity must be partial');

    const constraint = await client.query(
      `select 1 from pg_constraint where conname = 'appointments_external_identity_pair'`,
    );
    expect(constraint.rows.length === 1, 'appointments_external_identity_pair constraint is missing');

    const fields = await client.query(
      `select name, options from "fields" where "collectionName" = 'appointments' and name in ('externalSource', 'externalId')`,
    );
    expect(fields.rows.length === 2, 'field metadata for external identity columns is missing');
    expect(
      fields.rows.every((row) => row.options.uiSchema['x-read-pretty'] === true),
      'external identity fields must be read-only in the UI',
    );

    const data = await client.query(
      `select count(*)::int as total, count("externalId")::int as imported from "appointments"`,
    );
    expect(data.rows[0].imported === 0, 'no appointment should carry an external identity before T-41 runs');

    console.log(
      JSON.stringify(
        { status: 'ok', appointments: data.rows[0].total, imported: data.rows[0].imported, t41: 'blocked' },
        null,
        2,
      ),
    );
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`Appointments migration-prep validation failed: ${error.message}`);
  process.exitCode = 1;
});
