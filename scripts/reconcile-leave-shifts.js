// One-time repair for shift rows saved before full leave synchronization was enabled.
// Uses a single guarded SQL update so collection overlap hooks cannot reject the
// internal transition from scheduled to onLeave.
const { Client } = require('pg');
const { loadEnv } = require('./nocobase-api');

async function main() {
  const env = loadEnv();
  const client = new Client({
    host: env.DB_HOST,
    port: Number(env.DB_PORT || 5432),
    database: env.DB_DATABASE,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    ssl: env.DB_DIALECT_OPTIONS_SSL_MODE === 'require'
      ? { rejectUnauthorized: env.DB_DIALECT_OPTIONS_SSL_REJECT_UNAUTHORIZED !== 'false' }
      : undefined,
  });
  await client.connect();
  try {
    const result = await client.query(`
      UPDATE "employeeShifts" AS shift
      SET
        "status" = 'onLeave',
        "calendarTitle" = 'On leave — ' || COALESCE(NULLIF(TRIM(CONCAT_WS(' ', staff."firstName", staff."lastName")), ''), 'Staff member'),
        "notes" = CONCAT_WS(
          ' ',
          NULLIF(shift."notes", ''),
          '[Availability leave ' || leave."id" || ']'
        ),
        "updatedAt" = NOW()
      FROM "staffAvailabilityLeaves" AS leave
      JOIN "staff" AS staff ON staff."id" = leave."staffId"
      WHERE shift."staffId" = leave."staffId"
        AND shift."status" NOT IN ('onLeave', 'cancelled')
        AND shift."startTime" < leave."endTime"
        AND shift."endTime" > leave."startTime"
        AND COALESCE(shift."notes", '') NOT LIKE '%[Leave override ' || leave."id" || ']%'
      RETURNING shift."id"
    `);
    console.log(JSON.stringify({ status: 'ok', updatedShiftIds: result.rows.map((row) => row.id) }));
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`Leave-shift reconciliation failed: ${error.message || error.code || String(error)}`);
  process.exitCode = 1;
});
