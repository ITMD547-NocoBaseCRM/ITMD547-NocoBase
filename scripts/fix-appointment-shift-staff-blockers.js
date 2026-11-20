// One-time cleanup for records identified by audit-appointment-shift-staff.js.
const { Client } = require('pg');
const { createClient, formatErrors, loadEnv } = require('./nocobase-api');

const UNCOVERED_PAST_APPOINTMENTS = [
  390349138362370,
  390349142556681,
  390349144653830,
  390349146750981,
  390349146750986,
];
const COMPLETED_WITHOUT_END = 390527809421312;
const COMPLETED_END = '2026-10-05T21:30:00.000Z'; // 150-minute booked service from 19:00Z.
const EMPTY_CANCELLED_SHIFT = 392015055945731;
const STAFF_TO_ACTIVATE = 392517424578560;

const assertOk = (result, label) => {
  if (!result.ok) throw new Error(`${label} failed (${result.status}): ${formatErrors(result.json)}`);
};

async function repairCompletedEndTime() {
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
    await db.query(
      'UPDATE "appointments" SET "endTime" = $1 WHERE "id" = $2 AND "status" = $3 AND "endTime" IS NULL',
      [COMPLETED_END, COMPLETED_WITHOUT_END, 'completed'],
    );
  } finally {
    await db.end();
  }
}

async function main() {
  const client = await createClient();
  for (const id of UNCOVERED_PAST_APPOINTMENTS) {
    const result = await client.request(`appointments:update?filterByTk=${id}`, { method: 'POST', body: { staffId: null } });
    assertOk(result, `unassign appointment ${id}`);
  }
  const staff = await client.request(`staff:update?filterByTk=${STAFF_TO_ACTIVATE}`, { method: 'POST', body: { active: 'active' } });
  assertOk(staff, `activate staff ${STAFF_TO_ACTIVATE}`);
  await repairCompletedEndTime();
  const shift = await client.request(`employeeShifts:destroy?filterByTk=${EMPTY_CANCELLED_SHIFT}`, { method: 'POST' });
  assertOk(shift, `remove empty cancelled shift ${EMPTY_CANCELLED_SHIFT}`);
  console.log(JSON.stringify({
    status: 'ok',
    unassignedAppointments: UNCOVERED_PAST_APPOINTMENTS,
    repairedAppointment: COMPLETED_WITHOUT_END,
    activatedStaff: STAFF_TO_ACTIVATE,
    removedShift: EMPTY_CANCELLED_SHIFT,
  }, null, 2));
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
