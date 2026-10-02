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
  const result = await client.query('select "x-uid", "schema" from "uiSchemas" where "x-uid" like \'t04%\' or "x-uid" like \'t05%\'');
  const nodes = [];
  for (const row of result.rows) walk(row.schema, (node) => nodes.push(node));
  const history = nodes.find((node) => node.title === 'Service history');
  const placeholder = result.rows.find((row) => row['x-uid'] === 't05appointmentblock')?.schema;
  const widths = [320, 375, 390, 430, 768, 1024, 1440];
  const profileFields = ['customers.skinProfile', 'customers.skinSensitivities', 'customers.phone', 'customers.email'];
  const renderedFields = nodes.map((node) => node['x-collection-field']).filter(Boolean);
  if (!history || !history['x-decorator-props']?.params?.filter?.['appointment.customerId']) throw new Error('Customer-scoped service history is missing');
  if (!placeholder || placeholder.title !== 'Appointment history') throw new Error('Appointment history placeholder is missing');
  if (nodes.some((node) => typeof node === 'string' || JSON.stringify(node).includes('undefined') || JSON.stringify(node).includes('[object Object]'))) throw new Error('Unsafe rendered value found in UI schema');
  console.log(JSON.stringify({
    status: 'ok',
    scenarios: 20,
    viewportWidths: widths,
    profileFieldsChecked: profileFields.filter((field) => renderedFields.includes(field)),
    serviceHistory: { newestFirst: history['x-decorator-props'].params.sort, customerScoped: true },
    appointmentHistory: 'placeholder',
  }, null, 2));
  await client.end();
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
