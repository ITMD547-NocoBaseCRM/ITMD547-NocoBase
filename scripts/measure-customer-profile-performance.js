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

async function measure(client, query, limit) {
  const plan = await client.query(`explain (analyze, format json) ${query}`, [limit]);
  const executionMs = plan.rows[0]['QUERY PLAN'][0]['Execution Time'];
  const rows = await client.query(query, [limit]);
  return { limit, rows: rows.rowCount, payloadBytes: Buffer.byteLength(JSON.stringify(rows.rows)), databaseExecutionMs: executionMs };
}

async function main() {
  const env = loadEnv(path.resolve(process.cwd(), '.env'));
  const client = new Client({ host: env.DB_HOST, port: Number(env.DB_PORT || 5432), database: env.DB_DATABASE, user: env.DB_USER, password: env.DB_PASSWORD, ssl: { rejectUnauthorized: false } });
  await client.connect();
  const directoryBaseline = 'select * from "customers" order by "createdAt" desc limit $1';
  const directoryOptimized = 'select "id", "firstName", "lastName", "phone", "status" from "customers" order by "createdAt" desc limit $1';
  const baseline = `select aps.*, a.*, s.*, st.* from "appointmentServices" aps join "appointments" a on a.id=aps."appointmentId" left join "services" s on s.id=aps."serviceId" left join "staff" st on st.id=a."staffId" join "customers" c on c.id=a."customerId" where c.email='us01.large-history@example.test' order by a."appointmentDate" desc, aps."createdAt" desc limit $1`;
  const optimized = `select aps.id, aps.notes, aps."appointmentId", aps."serviceId", s.name as service, a."appointmentDate", a.status, st."firstName" as "staffFirstName", st."lastName" as "staffLastName" from "appointmentServices" aps join "appointments" a on a.id=aps."appointmentId" left join "services" s on s.id=aps."serviceId" left join "staff" st on st.id=a."staffId" join "customers" c on c.id=a."customerId" where c.email='us01.large-history@example.test' order by a."appointmentDate" desc, aps."createdAt" desc limit $1`;
  const result = { method: 'database-only EXPLAIN ANALYZE and JSON payload comparison; not a page-load or 4G measurement', directory: { baseline: await measure(client, directoryBaseline, 20), optimized: await measure(client, directoryOptimized, 10) }, serviceHistory: { baseline: await measure(client, baseline, 20), optimized: await measure(client, optimized, 10) } };
  await client.end();
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
