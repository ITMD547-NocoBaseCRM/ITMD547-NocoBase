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
  const customers = await client.query('select id,"firstName","lastName",email,"skinProfile","skinSensitivities" from "customers" where email like \'us01.%@example.test\' or ("firstName"=\'US01 Demo\') order by "lastName"');
  if (customers.rows.length !== 8) throw new Error(`Expected 8 US-01 seeded customers, found ${customers.rows.length}`);
  const histories = await client.query('select a."customerId", count(*)::int as count from "appointments" a where a.notes like \'[US-01 seed:%\' group by a."customerId"');
  const acl = await client.query('select r."roleName", a.name, a.fields from "dataSourcesRolesResources" r join "dataSourcesRolesResourcesActions" a on a."rolesResourceId"=r.id where r.name=\'customers\' and r."roleName" in (\'r_staff\',\'r_receptionist\') and a.name=\'view\'');
  const profileFields = ['skinProfile', 'skinProfileOther', 'skinSensitivities', 'skinSensitivitiesOther'];
  for (const row of acl.rows) for (const field of profileFields) if (!row.fields.includes(field)) throw new Error(`${row.roleName} customer view is missing ${field}`);
  const totalHistory = histories.rows.reduce((sum, row) => sum + row.count, 0);
  if (totalHistory !== 35) throw new Error(`Expected 35 seeded service-history appointments, found ${totalHistory}`);
  await client.end();
  console.log(JSON.stringify({ status: 'ok', customers: customers.rows.length, serviceHistoryAppointments: totalHistory, rolesWithProfileAccess: [...new Set(acl.rows.map((row) => row.roleName))] }, null, 2));
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
