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

async function main() {
  const env = loadEnv(path.resolve(process.cwd(), '.env'));
  const client = new Client({ host: env.DB_HOST, port: Number(env.DB_PORT || 5432), database: env.DB_DATABASE, user: env.DB_USER, password: env.DB_PASSWORD, ssl: { rejectUnauthorized: false } });
  await client.connect();
  const result = await client.query('select "x-uid", "schema" from "uiSchemas" where "x-uid" in (\'hf6ddg90ato\', \'t04historyblock\')');
  const byUid = Object.fromEntries(result.rows.map((row) => [row['x-uid'], row.schema?.['x-decorator-props']?.params]));
  const directory = byUid.hf6ddg90ato;
  const params = byUid.t04historyblock;
  const expectedDirectoryFields = ['id', 'firstName', 'lastName', 'phone', 'status'];
  if (directory?.pageSize !== 10) throw new Error(`Expected customer-directory page size 10, found ${directory?.pageSize}`);
  if (JSON.stringify(directory.fields) !== JSON.stringify(expectedDirectoryFields)) throw new Error('Customer-directory fields are not constrained to rendered fields');
  const expectedFields = ['id', 'notes', 'appointmentId', 'serviceId'];
  const expectedAppends = ['service', 'appointment', 'appointment.staff'];
  if (params?.pageSize !== 10) throw new Error(`Expected service-history page size 10, found ${params?.pageSize}`);
  if (JSON.stringify(params.fields) !== JSON.stringify(expectedFields)) throw new Error('Service-history fields are not constrained to rendered base fields');
  if (JSON.stringify(params.appends) !== JSON.stringify(expectedAppends)) throw new Error('Service-history relations are not explicitly appended');
  if (!params.filter?.['appointment.customerId']?.$eq?.includes('$nRecord.id')) throw new Error('Customer-scoped service-history filter is missing');
  if (!params.sort?.includes('-appointment.appointmentDate')) throw new Error('Newest-first service-history sort is missing');
  await client.end();
  console.log(JSON.stringify({ status: 'ok', directory: { initialPageSize: directory.pageSize, fields: directory.fields }, serviceHistory: { initialPageSize: params.pageSize, fields: params.fields, appends: params.appends, pagination: true } }, null, 2));
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
