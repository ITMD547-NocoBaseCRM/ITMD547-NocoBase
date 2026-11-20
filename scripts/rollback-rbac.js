// Restores role permissions from scripts/backups/rbac-before.json (taken before the RBAC rebuild).
//
// Usage: yarn rollback:rbac [--check] [--file path/to/backup.json]
//
// Restores, for admin/manager/member/receptionist/staff: role snippets, allowConfigure, allowNewMenu, the role
// strategy, the main data-source strategy, each configured collection's actions (fields and scopes), and the menu
// items each role can see. Scopes created by the rebuild are left in place (unused). User role assignments are not
// touched by the rebuild, so there is nothing to restore there. Workflow versions changed by the rebuild are listed
// in docs/rbac.md (re-enable the previous version in Workflow → Versions to undo them).

const fs = require('fs');
const path = require('path');
const { createClient, formatErrors } = require('./nocobase-api');

async function main() {
  const check = process.argv.includes('--check');
  const fileArg = process.argv.indexOf('--file');
  const file = fileArg > 0 ? process.argv[fileArg + 1] : path.join(__dirname, 'backups', 'rbac-before.json');
  const backup = JSON.parse(fs.readFileSync(file, 'utf8'));
  const client = await createClient();
  const call = async (action, opts) => {
    const r = await client.request(action, opts);
    if (!r.ok) throw new Error(`${action.split('?')[0]} failed (${r.status}):\n${formatErrors(r.json)}`);
    return r.json && r.json.data;
  };
  const q = (v) => encodeURIComponent(JSON.stringify(v));
  for (const [roleName, saved] of Object.entries(backup.roles)) {
    const { snippets, allowConfigure, allowNewMenu, strategy } = saved.role;
    console.log(`${check ? 'would restore' : 'restoring'} ${roleName}`);
    if (check) continue;
    await call(`roles:update?filterByTk=${roleName}`, { method: 'POST', body: { snippets, allowConfigure, allowNewMenu, strategy } });
    await call(`dataSources/main/roles:update?filterByTk=${roleName}`, { method: 'POST', body: { strategy: saved.dataSourceStrategy } });
    const current = (await call(`roles/${roleName}/resources:list?paginate=false`)) || [];
    const names = new Set([...current.map((r) => r.name), ...saved.resources.map((r) => r.name)]);
    for (const name of names) {
      const before = saved.resources.find((r) => r.name === name);
      const values = before
        ? { dataSourceKey: 'main', name, usingActionsConfig: before.usingActionsConfig, actions: before.actions }
        : { dataSourceKey: 'main', name, usingActionsConfig: false, actions: [] };
      if (current.find((r) => r.name === name)) await call(`roles/${roleName}/dataSourceResources:update?filter=${q({ dataSourceKey: 'main', name })}`, { method: 'POST', body: values });
      else await call(`roles/${roleName}/dataSourceResources:create`, { method: 'POST', body: values });
    }
    await call(`roles/${roleName}/desktopRoutes:set`, { method: 'POST', body: saved.desktopRoutes });
  }
  console.log(check ? 'check done' : 'rollback done');
}

main().catch((error) => {
  console.error(`RBAC rollback failed: ${error.message}`);
  process.exitCode = 1;
});
