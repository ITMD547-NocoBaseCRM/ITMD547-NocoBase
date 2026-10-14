// Creates the customerActivity view, the cached activity columns on customers and their triggers.
//   scripts/migrations/20261013_customer_activity.sql          (view, indexes, visitCount sync)
//   scripts/migrations/20261013_customer_activity_columns.sql  (columns, refresh function, triggers, backfill)
//
// Usage: yarn migrate:customer-activity
//
// Idempotent. Follow with `yarn apply:customer-activity` to register everything in NocoBase and update the page.

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { loadEnv } = require('./nocobase-api');

const MIGRATIONS = ['20261013_customer_activity.sql', '20261013_customer_activity_columns.sql'];

async function main() {
  const env = loadEnv();
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
    for (const file of MIGRATIONS) {
      await client.query(fs.readFileSync(path.join(__dirname, 'migrations', file), 'utf8'));
      console.log(`applied ${file}`);
    }
    const { rows } = await client.query(
      'SELECT COUNT(*)::int AS customers, COUNT(*) FILTER (WHERE "visitCount" > 0)::int AS visited, MIN("activityRefreshedAt") AS oldest_refresh FROM "customers"',
    );
    console.log(`customer activity ready: ${rows[0].customers} customers, ${rows[0].visited} with completed visits, oldest refresh ${rows[0].oldest_refresh}.`);
    console.log('Next: yarn apply:customer-activity (registers the fields and the nightly workflow, updates the Customers page).');
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`Customer activity migration failed: ${error.message}`);
  process.exitCode = 1;
});
