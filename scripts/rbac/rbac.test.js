// Static checks of the RBAC spec (no server needed). Live checks are in scripts/rbac/verify-rbac.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { ROLES, SCOPES } = require('./rbac-spec');

const SYSTEM = ['workflows', 'flow_nodes', 'executions', 'roles', 'rolesUsers', 'users', 'applicationPlugins', 'apiKeys', 'environmentVariables',
  'authenticators', 'dataSources', 'collections', 'fields', 'systemSettings', 'desktopRoutes', 'flowModels', 'uiSchemas'];

test('no business role has a blanket data strategy', () => {
  for (const [name, role] of Object.entries(ROLES)) assert.deepEqual(role.strategy, [], `${name} strategy`);
});

test('no business role can configure the UI or add menus', () => {
  for (const [name, role] of Object.entries(ROLES)) {
    assert.equal(role.allowConfigure, false, name);
    assert.equal(role.allowNewMenu, false, name);
    assert.ok(!role.snippets.some((s) => s === 'pm' || s === 'pm.*' || s.startsWith('ui.') || s === 'app'), `${name} snippets ${role.snippets}`);
  }
});

test('system collections are never granted beyond read-only user/role names', () => {
  for (const [name, role] of Object.entries(ROLES)) {
    for (const coll of SYSTEM) {
      const actions = role.collections[coll];
      if (!actions) continue;
      assert.ok(['users', 'roles'].includes(coll), `${name} has ${coll}`);
      assert.deepEqual(actions.map((a) => a.name), ['view'], `${name} ${coll}`);
      const fields = actions[0].fields;
      assert.ok(fields.length && !fields.includes('password') && !fields.includes('resetToken') && !fields.includes('roles'), `${name} ${coll} fields`);
    }
  }
});

test('member has nothing but the Access Pending page', () => {
  assert.deepEqual(ROLES.member.collections, {});
  assert.deepEqual(ROLES.member.menus.include, [['Access Pending']]);
});

test('receptionist cannot delete records, change prices or see payments', () => {
  const r = ROLES.receptionist.collections;
  for (const [coll, actions] of Object.entries(r)) {
    if (coll === 'appointmentServices' || coll === 'customerSavedViews') continue; // booked-service lines; own saved views
    assert.ok(!actions.some((a) => a.name === 'destroy'), `receptionist destroy on ${coll}`);
  }
  for (const coll of ['services', 'serviceCategories', 'memberships', 'membershipBenefits', 'staff']) {
    assert.deepEqual(r[coll].map((a) => a.name), ['view'], coll);
  }
  assert.equal(r.payments, undefined);
  assert.equal(r.customerMessages, undefined);
  const view = r.customers.find((a) => a.name === 'view').fields;
  assert.ok(!view.includes('totalSpent') && !view.includes('payments'));
  for (const action of ['create', 'update']) {
    const fields = r.customers.find((a) => a.name === action).fields;
    assert.ok(!fields.some((f) => /OptIn/.test(f)), `receptionist ${action} consent fields`);
  }
  assert.deepEqual(r.communication_consent_events.map((a) => a.name), ['create', 'view']);
});

test('every staff read of personal data is scoped to the linked staff record', () => {
  const s = ROLES.staff.collections;
  for (const coll of ['appointments', 'appointments_time_view', 'appointmentServices', 'customers', 'customerActivity', 'customerNotes',
    'employeeShifts', 'staff', 'services', 'staffServices', 'staffAvailabilitySchedules', 'staffAvailabilityOverrides', 'staffAvailabilityLeaves', 'payments']) {
    const view = s[coll].find((a) => a.name === 'view');
    assert.ok(view && view.scope, `staff ${coll} view must be scoped`);
    const scope = SCOPES[view.scope];
    assert.ok(scope, `scope ${view.scope} defined`);
    assert.equal(scope.resourceName, coll, `scope ${view.scope} resource`);
    assert.match(JSON.stringify(scope.scope), /\$user\.staff\.id/);
    assert.match(JSON.stringify(scope.scope), /\$exists/, `${view.scope} must refuse users without a staff record`);
  }
  const pay = s.payments[0].fields;
  for (const f of ['transactionReference', 'paymentMethod', 'notes', 'customer', 'customerId']) assert.ok(!pay.includes(f), `staff payment field ${f}`);
  for (const coll of ['memberships', 'customerMemberships', 'communication_consent_events', 'communication_suppressions', 'customerMessages']) {
    assert.equal(s[coll], undefined, `staff must not access ${coll}`);
  }
  const fields = s.customers[0].fields;
  for (const f of ['email', 'address', 'dateOfBirth', 'totalSpent', 'payments', 'emailMarketingOptIn', 'notes']) assert.ok(!fields.includes(f), `staff customer field ${f}`);
  assert.deepEqual(s.appointments.find((a) => a.name === 'update').fields, ['status', 'notes']);
});

test('manager has no settings pages except customer reviews', () => {
  assert.deepEqual(ROLES.manager.snippets.filter((x) => !x.startsWith('!')), ['pm.customer-reviews']);
  assert.equal(ROLES.manager.collections.users[0].name, 'view');
});

test('all referenced scopes exist and match their collection', () => {
  for (const role of Object.values(ROLES)) {
    for (const [coll, actions] of Object.entries(role.collections)) {
      for (const a of actions) if (a.scope) assert.equal(SCOPES[a.scope] && SCOPES[a.scope].resourceName, coll, `${a.scope} on ${coll}`);
    }
  }
});
