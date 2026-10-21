// Adds and maintains the derived appointment calendar color field, backfills existing rows,
// and configures every appointment calendar to use it.
const { createClient, formatErrors, loadEnv } = require('./nocobase-api');
const { Client } = require('pg');

const FIELD = 'calendarColor';
const ENUM = [
  { value: 'unassigned', label: 'Unassigned', color: 'red' },
  { value: 'scheduled', label: 'Scheduled', color: 'blue' },
  { value: 'confirmed', label: 'Checked in', color: 'cyan' },
  { value: 'inProgress', label: 'In progress', color: 'gold' },
  { value: 'completed', label: 'Completed', color: 'green' },
  { value: 'cancelled', label: 'Cancelled', color: 'default' },
  { value: 'noShow', label: 'No show', color: 'volcano' },
];
const fail = (what, result) => new Error(`${what} failed (${result.status}):\n${formatErrors(result.json)}`);
const colorOf = (row) => !row.staffId ? 'unassigned'
  : ENUM.some((item) => item.value === row.status && item.value !== 'unassigned') ? row.status : 'scheduled';

async function listAllModels(client) {
  const all = [];
  for (let page = 1; page <= 10; page += 1) {
    const result = await client.request(`flowModels:list?pageSize=1000&page=${page}`);
    if (!result.ok) throw fail('list flow models', result);
    const rows = result.json?.data || [];
    all.push(...rows);
    if (rows.length < 1000) break;
  }
  return all;
}

async function ensureField(client, check) {
  const current = await client.request(`collections/appointments/fields:get?filterByTk=${FIELD}`);
  if (current.ok) {
    const same = JSON.stringify(current.json?.data?.enum || []) === JSON.stringify(ENUM);
    if (check || same) return { status: 'present', changed: !same };
    const updated = await client.request(`collections/appointments/fields:update?filterByTk=${FIELD}`, {
      method: 'POST', body: { enum: ENUM, uiSchema: { type: 'string', title: 'Calendar color', 'x-component': 'Select', enum: ENUM } },
    });
    if (!updated.ok) throw fail('update appointments.calendarColor', updated);
    return { status: 'updated', changed: true };
  }
  if (check) return { status: 'missing', changed: true };
  const created = await client.request('collections/appointments/fields:create', {
    method: 'POST',
    body: {
      name: FIELD, type: 'string', interface: 'select', enum: ENUM,
      uiSchema: { type: 'string', title: 'Calendar color', 'x-component': 'Select', enum: ENUM },
    },
  });
  if (!created.ok) throw fail('create appointments.calendarColor', created);
  return { status: 'created', changed: true };
}

async function backfill(client, check) {
  const result = await client.request('appointments:list?paginate=false&fields=id,status,staffId,calendarColor');
  if (!result.ok) throw fail('list appointments for color backfill', result);
  const rows = result.json?.data || [];
  const stale = rows.filter((row) => row.calendarColor !== colorOf(row));
  if (!check && stale.length) {
    // This is a data migration, not an appointment edit. Updating through the resource action
    // would re-run shift/conflict validation and can reject legitimate historical rows.
    const env = { ...loadEnv(), ...process.env };
    const db = new Client({
      host: env.DB_HOST,
      port: Number(env.DB_PORT || 5432),
      database: env.DB_DATABASE,
      user: env.DB_USER,
      password: env.DB_PASSWORD,
      ssl: env.DB_DIALECT_OPTIONS_SSL_MODE === 'require'
        ? { rejectUnauthorized: env.DB_DIALECT_OPTIONS_SSL_REJECT_UNAUTHORIZED !== 'false' }
        : undefined,
    });
    await db.connect();
    try {
      await db.query('BEGIN');
      for (const row of stale) {
        await db.query('UPDATE "appointments" SET "calendarColor" = $1 WHERE "id" = $2', [colorOf(row), row.id]);
      }
      await db.query('COMMIT');
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    } finally {
      await db.end();
    }
  }
  return { total: rows.length, changed: stale.length };
}

async function configureCalendars(client, check) {
  const calendars = (await listAllModels(client)).filter((model) => model.use === 'CalendarBlockModel'
    && model.stepParams?.resourceSettings?.init?.collectionName === 'appointments');
  const results = [];
  for (const calendar of calendars) {
    const current = calendar.stepParams?.calendarSettings?.colorField?.colorFieldName;
    if (current !== FIELD && !check) {
      const updated = await client.request('flowSurfaces:configure', {
        method: 'POST', body: { target: { uid: calendar.uid }, changes: { colorField: FIELD } },
      });
      if (!updated.ok) throw fail(`configure appointment calendar ${calendar.uid}`, updated);
    }
    results.push({ uid: calendar.uid, changed: current !== FIELD });
  }
  return results;
}

async function main() {
  const check = process.argv.includes('--check');
  const client = await createClient();
  const field = await ensureField(client, check);
  if (check && field.status === 'missing') {
    console.log(JSON.stringify({ status: 'ok', mode: 'check', target: client.baseUrl, field, appointments: { total: 0, changed: 0 }, calendars: [] }, null, 2));
    return;
  }
  const appointments = await backfill(client, check);
  const calendars = await configureCalendars(client, check);
  console.log(JSON.stringify({ status: 'ok', mode: check ? 'check' : 'apply', target: client.baseUrl, field, appointments, calendars }, null, 2));
}
main().catch((error) => { console.error(`Appointment calendar colors apply failed: ${error.message}`); process.exitCode = 1; });
