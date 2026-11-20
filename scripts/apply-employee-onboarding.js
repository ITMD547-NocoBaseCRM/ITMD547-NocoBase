// Installs the employee-onboarding UI (docs/employee-onboarding.md): the "Employee accounts" panel on the Staff page
// and the "My Workspace" page for Staff. Menu permissions come from scripts/rbac/rbac-spec.js (run yarn apply:rbac).
//
// Usage: yarn apply:employee-onboarding [--check]
//
// The server side (onboarding actions, tables, staff workspace endpoint) ships with @salon/plugin-auth-clerk and
// @parlour/plugin-crm. The unique constraint on staff.userId is added here if missing.

const fs = require('fs');
const path = require('path');
const { createClient } = require('./nocobase-api');
const { applyOnboardingUi } = require('./onboarding/onboarding-ui-core');

async function main() {
  const check = process.argv.includes('--check');
  const client = await createClient();
  const request = (action, opts) => client.request(action, opts);
  const read = (f) => fs.readFileSync(path.join(__dirname, 'ui', f), 'utf8');
  const field = await request('collections/staff/fields:get?filterByTk=userId');
  if (field.ok && field.json && field.json.data && !field.json.data.unique) {
    console.log(`${check ? 'would add' : 'adding'} unique constraint on staff.userId`);
    if (!check) {
      const r = await request('collections/staff/fields:update?filterByTk=userId', { method: 'POST', body: { unique: true } });
      if (!r.ok) throw new Error(`staff.userId unique failed (${r.status}) – check for employees sharing a user first`);
    }
  }
  const changes = await applyOnboardingUi(request, {
    panelCode: read('employee-accounts-panel.js'),
    workspaceCode: read('staff-workspace-block.js'),
    check,
    log: (m) => console.log(`${check ? 'would: ' : ''}${m}`),
  });
  console.log(JSON.stringify({ status: 'ok', mode: check ? 'check' : 'apply', target: client.baseUrl, changes: changes.length }, null, 2));
}

main().catch((error) => {
  console.error(`Employee onboarding apply failed: ${error.message}`);
  process.exitCode = 1;
});
