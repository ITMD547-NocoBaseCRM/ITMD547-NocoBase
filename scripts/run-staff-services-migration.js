const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { loadEnv } = require('./nocobase-api');

async function main() {
  const env = loadEnv();
  const required = ['DB_HOST', 'DB_DATABASE', 'DB_USER', 'DB_PASSWORD'];
  const missing = required.filter((key) => !env[key]);
  if (missing.length) throw new Error(`Missing database settings: ${missing.join(', ')}`);

  const migrationPath = path.join(__dirname, 'migrations', '20261112_staff_services.sql');
  const client = new Client({
    host: env.DB_HOST,
    port: Number(env.DB_PORT || 5432),
    database: env.DB_DATABASE,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    ssl: { rejectUnauthorized: env.DB_DIALECT_OPTIONS_SSL_REJECT_UNAUTHORIZED !== 'false' },
  });
  client.on('notice', (notice) => console.log(`notice: ${notice.message}`));

  await client.connect();
  try {
    await client.query(fs.readFileSync(migrationPath, 'utf8'));
    console.log('Staff-services relation applied. No assignment rows were created.');
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`Staff-services migration failed: ${error.message}`);
  process.exitCode = 1;
});