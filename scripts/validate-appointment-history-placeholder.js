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

function walk(value, visit) {
  if (!value || typeof value !== 'object') return;
  visit(value);
  for (const child of Object.values(value)) walk(child, visit);
}

async function main() {
  const env = loadEnv(path.resolve(process.cwd(), '.env'));
  const client = new Client({ host: env.DB_HOST, port: Number(env.DB_PORT || 5432), database: env.DB_DATABASE, user: env.DB_USER, password: env.DB_PASSWORD, ssl: { rejectUnauthorized: false } });
  await client.connect();
  const result = await client.query('select "x-uid", "schema" from "uiSchemas" where "x-uid" in (\'t05appointmentrow\', \'t05appointmentcol\', \'t05appointmentblock\')');
  const nodes = [];
  for (const row of result.rows) walk(row.schema, (node) => nodes.push(node));
  const block = result.rows.find((row) => row['x-uid'] === 't05appointmentblock')?.schema;
  if (!block || block.title !== 'Appointment history') throw new Error('Missing appointment history placeholder card');
  if (!block.description || !/will appear here when appointment tracking is available/i.test(block.description)) throw new Error('Missing future appointment-history placeholder text');
  if (block['x-decorator'] || block['x-decorator-props'] || block['x-collection-field']) throw new Error('Placeholder must not query a collection');
  if (nodes.some((node) => node['x-collection-field']?.startsWith('appointments.'))) throw new Error('Placeholder must not expose appointment records');
  await client.end();
  console.log(JSON.stringify({ status: 'ok', placeholderUid: 't05appointmentblock', dataSource: 'none', message: block.description }, null, 2));
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
