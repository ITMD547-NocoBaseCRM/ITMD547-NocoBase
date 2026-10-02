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
  const result = await client.query("select \"x-uid\", \"schema\" from \"uiSchemas\" where \"x-uid\" like 't04%'");
  const nodes = [];
  for (const row of result.rows) walk(row.schema, (node) => nodes.push(node));
  const fields = nodes.map((node) => node['x-collection-field']).filter(Boolean);
  const history = nodes.find((node) => node.title === 'Service history');
  const historyFilter = history?.['x-decorator-props']?.params?.filter;
  const requiredFields = [
    'customers.skinProfile',
    'customers.skinProfileOther',
    'customers.skinSensitivities',
    'customers.skinSensitivitiesOther',
  ];
  for (const field of requiredFields) if (!fields.includes(field)) throw new Error(`Missing profile field: ${field}`);
  if (!history) throw new Error('Missing service history block');
  if (!historyFilter?.['appointment.customerId']?.$eq?.includes('$nRecord.id')) throw new Error('Service history is not customer-scoped');
  await client.end();
  console.log(JSON.stringify({
    status: 'ok',
    profileFields: requiredFields,
    historyFields: fields.filter((field) => field.startsWith('appointmentServices.')),
    serviceHistoryFilter: historyFilter,
    emptySensitivityText: nodes.find((node) => node['x-collection-field'] === 'customers.skinSensitivities')?.['x-component-props']?.emptyText,
  }, null, 2));
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
