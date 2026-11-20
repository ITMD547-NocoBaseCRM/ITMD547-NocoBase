// Live RBAC checks: probes the API as each role's test account. Environment-neutral like rbac-core:
// `as(role)` returns a request function (action, { method, body, headers }) => { ok, status, json } for that role's
// session ('public' = no session). Read-only except a no-op status re-save on one of the staff user's own appointments.

async function verifyRbac(as, ctx) {
  const results = [];
  const rec = (role, name, pass, detail = '') => results.push({ role, name, pass: !!pass, detail: String(detail).slice(0, 200) });
  const q = (v) => encodeURIComponent(JSON.stringify(v));
  const denied = (r) => r.status === 401 || r.status === 403;
  // environmentVariables:list answers every signed-in user but returns nothing to non-admins.
  const deniedOrEmpty = (r) => denied(r) || (r.ok && Array.isArray(r.json && r.json.data) && r.json.data.length === 0);
  const RANGE = { from: '2026-01-01', to: '2026-12-31' };
  const rows = (r) => (r.json && Array.isArray(r.json.data) ? r.json.data : []);
  const probe = async (role, name, action, expect, opts) => {
    const r = await as(role)(action, opts);
    const ok = expect === 'deny' ? denied(r) : expect === 'allow' ? r.ok : expect(r);
    rec(role, name, ok, `${action.split('?')[0]} -> ${r.status}`);
    return r;
  };
  const { graceStaffId, otherCustomerId, otherAppointmentId, otherStaffId } = ctx;

  // ---------- Member ----------
  for (const res of ['customers', 'appointments', 'payments', 'staff', 'employeeShifts', 'customerNotes', 'services', 'memberships',
    'communication_consent_events', 'communication_suppressions', 'customer_reviews', 'customer_review_invitations', 'staffAvailabilityLeaves',
    'staffAvailabilitySchedules', 'appointmentAvailabilitySettings', 'customerMessages', 'workflows', 'roles', 'users', 'apiKeys', 'authenticators',
    'environmentVariables', 'clerkStaffLinks']) {
    await probe('member', `cannot list ${res}`, `${res}:list?pageSize=1`, res === 'environmentVariables' ? deniedOrEmpty : 'deny');
  }
  await probe('member', 'cannot create a customer', 'customers:create', 'deny', { method: 'POST', body: { firstName: 'RBAC', lastName: 'Probe' } });
  await probe('member', 'cannot read review scores', 'customerReviewAdmin:scores', 'deny', { method: 'POST', body: RANGE });
  await probe('member', 'cannot list reviews', 'customerReviewAdmin:listReviews', 'deny', { method: 'POST', body: {} });
  await probe('member', 'cannot query staff availability', 'appointmentAvailability:availableStaff', 'deny', { method: 'POST', body: { startTime: '2026-11-20T20:00:00Z', endTime: '2026-11-20T20:45:00Z' } });
  await probe('member', 'cannot list plugins', 'pm:list', 'deny');
  await probe('member', 'cannot enable plugins', 'pm:enable', 'deny', { method: 'POST', body: { filterByTk: ['nonexistent'] } });
  await probe('member', 'cannot change system settings', 'systemSettings:update?filterByTk=1', 'deny', { method: 'POST', body: {} });
  await probe('member', 'session works (auth:check)', 'auth:check', 'allow');
  await probe('member', 'menu shows only Access Pending', 'desktopRoutes:listAccessible?tree=true', (r) => {
    const titles = rows(r).map((x) => x.title);
    return r.ok && titles.length === 1 && titles[0] === 'Access Pending';
  });

  // ---------- Staff (staff_test, linked to Grace Kim) ----------
  const sAppts = await probe('staff', 'lists appointments', 'appointments:list?pageSize=500', 'allow');
  rec('staff', 'sees only own appointments', rows(sAppts).length > 0 && rows(sAppts).every((a) => String(a.staffId) === String(graceStaffId)), `${rows(sAppts).length} rows`);
  await probe('staff', "cannot open another technician's appointment by id", `appointments:get?filterByTk=${otherAppointmentId}`, (r) => denied(r) || !(r.json && r.json.data));
  await probe('staff', "cannot filter into other technicians' appointments", `appointments:list?filter=${q({ staffId: otherStaffId })}`, (r) => r.ok && rows(r).length === 0);
  await probe('staff', "cannot change another technician's appointment", `appointments:update?filterByTk=${otherAppointmentId}`, (r) => denied(r) || (r.ok && Array.isArray(r.json.data) && r.json.data.length === 0), { method: 'POST', body: { notes: 'rbac probe' } });
  await probe('staff', 'cannot delete appointments', `appointments:destroy?filterByTk=${otherAppointmentId}`, 'deny', { method: 'POST' });
  await probe('staff', 'cannot export appointments', 'appointments:export', 'deny', { method: 'POST', body: {} });
  const own = rows(sAppts)[0];
  if (own) await probe('staff', 'can re-save status of own appointment', `appointments:update?filterByTk=${own.id}`, 'allow', { method: 'POST', body: { status: own.status } });
  await probe('staff', 'dashboard-style related paths work (customer name, booked price)', 'appointments:list?pageSize=3&fields[]=id&fields[]=customer.firstName&fields[]=appointmentServices.priceAtBooking',
    (r) => r.ok && rows(r).length > 0 && rows(r).every((a) => a.customer && 'firstName' in a.customer));
  await probe('staff', 'related customer record is trimmed (no email/address/consent)', 'appointments:list?pageSize=5&appends[]=customer&fields[]=id&fields[]=customer.email',
    (r) => r.ok && rows(r).every((a) => !a.customer || (!('email' in a.customer) && !('address' in a.customer) && !('emailMarketingOptIn' in a.customer))));
  await probe('staff', 'related payments are trimmed', 'appointments:list?pageSize=5&appends[]=payments', (r) => r.ok && rows(r).every((a) => (a.payments || []).every((p) => !('transactionReference' in p) && !('paymentMethod' in p))));
  const sCust = await probe('staff', 'lists customers', 'customers:list?pageSize=500&appends[]=appointments', 'allow');
  rec('staff', 'sees only customers of own appointments', rows(sCust).every((c) => (c.appointments || []).some((a) => String(a.staffId) === String(graceStaffId))), `${rows(sCust).length} rows`);
  rec('staff', 'customer email/address/DOB/spend/consent hidden', rows(sCust).every((c) => !('email' in c) && !('address' in c) && !('dateOfBirth' in c) && !('totalSpent' in c) && !('emailMarketingOptIn' in c)), Object.keys(rows(sCust)[0] || {}).join(','));
  await probe('staff', 'cannot open an unrelated customer', `customers:get?filterByTk=${otherCustomerId}`, (r) => denied(r) || !(r.json && r.json.data));
  await probe('staff', 'cannot reach unrelated customer data via association', `customers/${otherCustomerId}/appointments:list`, (r) => denied(r) || rows(r).every((a) => String(a.staffId) === String(graceStaffId)));
  const sShifts = await probe('staff', 'lists shifts', 'employeeShifts:list?pageSize=500', 'allow');
  rec('staff', 'sees only own shifts', rows(sShifts).every((s) => String(s.staffId) === String(graceStaffId)), `${rows(sShifts).length} rows`);
  const sStaff = await probe('staff', 'lists staff', 'staff:list?pageSize=50', 'allow');
  rec('staff', 'sees only own employee record', rows(sStaff).length === 1 && String(rows(sStaff)[0].id) === String(graceStaffId), `${rows(sStaff).length} rows`);
  const sNotes = await probe('staff', 'lists customer notes', 'customerNotes:list?pageSize=500', 'allow');
  rec('staff', 'notes are own or unassigned on own customers', rows(sNotes).every((n) => n.staffId == null || String(n.staffId) === String(graceStaffId)), `${rows(sNotes).length} rows`);
  const sScores = await probe('staff', 'reads review scores', 'customerReviewAdmin:scores', 'allow', { method: 'POST', body: { ...RANGE, staffId: String(otherStaffId) } });
  rec('staff', 'scores show only own (staffId param ignored)', !JSON.stringify(sScores.json || {}).includes(String(otherStaffId)), JSON.stringify(sScores.json || {}).slice(0, 160));
  const sPay = await probe('staff', 'reads payments for own performance', 'payments:list?pageSize=500&appends[]=appointment', 'allow');
  rec('staff', 'payments only on own appointments, no method/reference', rows(sPay).every((p) => p.appointment && String(p.appointment.staffId) === String(graceStaffId) && !('transactionReference' in p) && !('paymentMethod' in p) && !('customerId' in p)), `${rows(sPay).length} rows`);
  await probe('staff', 'cannot export payments', 'payments:export', 'deny', { method: 'POST', body: {} });
  for (const res of ['memberships', 'customerMemberships', 'communication_consent_events', 'communication_suppressions', 'customerMessages', 'customer_reviews', 'workflows', 'roles']) {
    await probe('staff', `cannot list ${res}`, `${res}:list?pageSize=1`, 'deny');
  }
  await probe('staff', 'cannot list reviews', 'customerReviewAdmin:listReviews', 'deny', { method: 'POST', body: {} });
  await probe('staff', 'cannot change service prices', 'services:update?filterByTk=1', 'deny', { method: 'POST', body: { price: 1 } });
  await probe('staff', 'cannot record consent', 'communication_consent_events:create', 'deny', { method: 'POST', body: {} });

  // ---------- Receptionist ----------
  const rCust = await probe('receptionist', 'lists customers', 'customers:list?pageSize=5', 'allow');
  rec('receptionist', 'customer spend hidden', rows(rCust).every((c) => !('totalSpent' in c) && !('payments' in c)), Object.keys(rows(rCust)[0] || {}).length + ' fields');
  await probe('receptionist', 'lists appointments', 'appointments:list?pageSize=5', 'allow');
  await probe('receptionist', 'related payments are removed from appointments', 'appointments:list?pageSize=5&appends[]=payments', (r) => r.ok && rows(r).every((a) => !('payments' in a)));
  await probe('receptionist', 'related customer has no spend total', 'appointments:list?pageSize=5&appends[]=customer', (r) => r.ok && rows(r).every((a) => !a.customer || !('totalSpent' in a.customer)));
  await probe('receptionist', 'cannot delete customers', `customers:destroy?filterByTk=${otherCustomerId}`, 'deny', { method: 'POST' });
  await probe('receptionist', 'cannot delete appointments', `appointments:destroy?filterByTk=${otherAppointmentId}`, 'deny', { method: 'POST' });
  await probe('receptionist', 'views services', 'services:list?pageSize=5', 'allow');
  await probe('receptionist', 'cannot change service prices', 'services:update?filterByTk=1', 'deny', { method: 'POST', body: { price: 1 } });
  const rStaff = await probe('receptionist', 'views staff list', 'staff:list?pageSize=50', 'allow');
  rec('receptionist', 'staff email/phone hidden', rows(rStaff).every((s) => !('email' in s) && !('phone' in s)), Object.keys(rows(rStaff)[0] || {}).join(','));
  await probe('receptionist', 'lists shifts', 'employeeShifts:list?pageSize=5', 'allow');
  await probe('receptionist', 'lists customer notes', 'customerNotes:list?pageSize=5', 'allow');
  await probe('receptionist', 'lists customer memberships', 'customerMemberships:list?pageSize=5', 'allow');
  await probe('receptionist', 'views review status', 'customerReviewAdmin:listReviews', 'allow', { method: 'POST', body: {} });
  await probe('receptionist', 'opens an appointment review summary', 'customerReviewAdmin:appointmentSummary', 'allow', { method: 'POST', body: { appointmentId: String(otherAppointmentId) } });
  await probe('receptionist', 'cannot moderate reviews', 'customerReviewAdmin:moderate', 'deny', { method: 'POST', body: { reviewId: '1', action: 'hide' } });
  await probe('receptionist', 'cannot revoke invitations', 'customerReviewAdmin:revoke', 'deny', { method: 'POST', body: { invitationId: '1' } });
  await probe('receptionist', 'cannot read staff review scores', 'customerReviewAdmin:scores', 'deny', { method: 'POST', body: RANGE });
  await probe('receptionist', 'cannot read review tables directly', 'customer_reviews:list?pageSize=1', 'deny');
  await probe('receptionist', 'views consent history', 'communication_consent_events:list?pageSize=1', 'allow');
  await probe('receptionist', 'cannot edit consent history', 'communication_consent_events:update?filterByTk=1', 'deny', { method: 'POST', body: { notes: 'x' } });
  await probe('receptionist', 'cannot create suppressions', 'communication_suppressions:create', 'deny', { method: 'POST', body: {} });
  await probe('receptionist', 'can check staff availability', 'appointmentAvailability:availableStaff', 'allow', { method: 'POST', body: { startTime: '2026-11-20T20:00:00Z', endTime: '2026-11-20T20:45:00Z' } });
  for (const res of ['payments', 'customerMessages', 'appointmentReminderSettings', 'workflows', 'roles', 'apiKeys', 'clerkStaffLinks']) {
    await probe('receptionist', `cannot list ${res}`, `${res}:list?pageSize=1`, 'deny');
  }

  // ---------- Manager ----------
  for (const res of ['customers', 'appointments', 'payments', 'services', 'memberships', 'customerMemberships', 'staff', 'employeeShifts', 'customerNotes',
    'communication_consent_events', 'communication_suppressions', 'customerMessages', 'users']) {
    await probe('manager', `lists ${res}`, `${res}:list?pageSize=1`, 'allow');
  }
  await probe('manager', 'reads all review scores', 'customerReviewAdmin:scores', 'allow', { method: 'POST', body: RANGE });
  await probe('manager', 'lists reviews', 'customerReviewAdmin:listReviews', 'allow', { method: 'POST', body: {} });
  await probe('manager', 'user passwords not readable', 'users:list?pageSize=5', (r) => r.ok && rows(r).every((u) => !('password' in u) && !('resetToken' in u)));
  for (const [name, action, opts, expect] of [
    ['cannot list workflows', 'workflows:list?pageSize=1'],
    ['cannot edit workflow nodes', 'flow_nodes:update?filterByTk=1', { method: 'POST', body: {} }],
    ['cannot list plugins', 'pm:list'],
    ['cannot enable plugins', 'pm:enable', { method: 'POST', body: { filterByTk: ['nonexistent'] } }],
    ['cannot list API keys', 'apiKeys:list?pageSize=1'],
    ['cannot read variables & secrets', 'environmentVariables:list?pageSize=1', undefined, deniedOrEmpty],
    ['cannot configure authentication', 'authenticators:update?filterByTk=basic', { method: 'POST', body: {} }],
    ['cannot change roles', 'roles:update?filterByTk=member', { method: 'POST', body: { snippets: ['pm'] } }],
    ['cannot change role permissions', 'roles/member/dataSourceResources:create', { method: 'POST', body: { dataSourceKey: 'main', name: 'customers', usingActionsConfig: true, actions: [{ name: 'view' }] } }],
    ['cannot assign roles to users', `users/${ctx.memberUserId}/roles:add`, { method: 'POST', body: ['admin'] }],
    ['cannot create user accounts', 'users:create', { method: 'POST', body: { username: 'rbac_probe', password: 'Probe!12345678' } }],
    ['cannot change system settings', 'systemSettings:update?filterByTk=1', { method: 'POST', body: {} }],
    ['cannot create collections', 'collections:create', { method: 'POST', body: { name: 'rbac_probe' } }],
    ['cannot manage Clerk staff links', 'clerkStaffLinks:list?pageSize=1'],
  ]) await probe('manager', name, action, expect || 'deny', opts);

  // ---------- Admin (current admin session) ----------
  for (const res of ['workflows', 'roles', 'users', 'apiKeys', 'customers', 'payments']) await probe('admin', `lists ${res}`, `${res}:list?pageSize=1`, 'allow');
  await probe('admin', 'lists plugins', 'pm:list', 'allow');
  await probe('admin', 'reads review scores', 'customerReviewAdmin:scores', 'allow', { method: 'POST', body: RANGE });

  // ---------- Public ----------
  await probe('public', 'cannot list customers', 'customers:list?pageSize=1', 'deny');
  await probe('public', 'cannot list reviews', 'customer_reviews:list?pageSize=1', 'deny');
  await probe('public', 'review link endpoint reachable without login (bad token refused by the handler)', 'customerReviewLinks:inspect', (r) => !denied(r) || /token|link|invalid|expired/i.test(JSON.stringify(r.json || {})), { method: 'POST', body: {}, headers: { 'X-Review-Token': 'not-a-real-token' } });

  return results;
}

module.exports = { verifyRbac };
