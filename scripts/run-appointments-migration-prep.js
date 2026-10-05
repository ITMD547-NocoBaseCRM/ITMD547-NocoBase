const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

function loadEnv(filePath) {
  const values = {};
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return values;
}

async function main() {
  const env = loadEnv(path.resolve(process.cwd(), '.env'));
  const migrationPath = path.join(__dirname, 'migrations', '20261002_prepare_appointments_migration.sql');
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
    await client.query(fs.readFileSync(migrationPath, 'utf8'));
    console.log(
      'Appointments migration-prep applied successfully (no data moved). Restart NocoBase to reload collection metadata.',
    );
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`Appointments migration-prep failed: ${error.message}`);
  process.exitCode = 1;
});
