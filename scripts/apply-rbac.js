// Applies the BeautyWithin role permissions (scripts/rbac/rbac-spec.js) to the running NocoBase.
//
// Usage: yarn apply:rbac [--check]
//
// Roles are never created, renamed or deleted, and no user's role assignments are changed. Admin and root keep
// their permissions. Back up first: scripts/backups/rbac-before.json holds the state before the first run, and
// `yarn rollback:rbac` restores it. Same credentials and target rules as the other apply scripts
// (.env: NOCOBASE_API_TOKEN or INIT_ROOT_EMAIL/INIT_ROOT_PASSWORD; NOCOBASE_API_URL).

const { createClient } = require('./nocobase-api');
const spec = require('./rbac/rbac-spec');
const { applyRbac } = require('./rbac/rbac-core');

async function main() {
  const check = process.argv.includes('--check');
  const client = await createClient();
  const changes = await applyRbac((action, opts) => client.request(action, opts), { spec, check, log: (m) => console.log(`${check ? 'would ' : ''}${m}`) });
  console.log(JSON.stringify({ status: 'ok', mode: check ? 'check' : 'apply', target: client.baseUrl, changes: changes.length }, null, 2));
}

main().catch((error) => {
  console.error(`RBAC apply failed: ${error.message}`);
  process.exitCode = 1;
});
