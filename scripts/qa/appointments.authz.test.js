// Authorization tests for appointment management with the real US-19 roles (US-26 / T-46).
//
// Temporary users hold exactly one role (r_staff or r_receptionist), and every request names that role the way the app
// does when a user switches role. A staff user is linked to a temporary technician row, because the staff scope
// ("Assigned to me") reads the technician linked to the signed-in user.
//
// Tests marked `todo` describe behaviour the acceptance criteria require but the current role grants do not give; they
// run and report, and turn into ordinary passing tests once the grants are fixed. Needs a running local NocoBase app.
// Run with: yarn test:appointments-qa-api

const assert = require('node:assert/strict');
const { isRejected, qaTest } = require('./support/harness');
const { QA_USER_PREFIX, body, count, id, qaDate, qaTime, rows } = require('./support/fixtures');

const encode = (value) => encodeURIComponent(JSON.stringify(value));
const sameId = (a, b) => String(a) === String(b);

// One staff login, one second technician (no login) and one receptionist login are shared by the tests.
let people = null;
async function getPeople({ world }) {
  if (!people) {
    people = (async () => {
      const staff = await world.createRoleUser('r_staff');
      const otherTechnician = (await world.createStaff()).id;
      const receptionist = await world.createRoleUser('r_receptionist', { linkStaff: false });
      return { staff, otherTechnician, receptionist };
    })();
  }
  return people;
}

// An own, a foreign (other technician) and an unassigned appointment, each with one booked service line.
async function seed(ctx) {
  const { world, reference } = ctx;
  const { staff, otherTechnician } = await getPeople(ctx);
  const customer = reference.shapes.multiple[0];
  const make = async (staffId, day) =>
    (
      await world.createAppointment({
        customerId: customer.id,
        staffId,
        appointmentDate: qaDate(day),
        startTime: qaTime(day, 9),
        appointmentServices: [{ serviceId: reference.services[0].id, priceAtBooking: 10, durationAtBooking: 30 }],
      })
    ).id;
  return {
    customer,
    own: await make(staff.staffId, 10),
    foreign: await make(otherTechnician, 11),
    unassigned: await make(null, 12),
  };
}

const inQaRange = encode({
  $and: [{ appointmentDate: { $gte: '2027-03-01' } }, { appointmentDate: { $lte: '2027-03-31' } }],
});
const notesOf = async (root, appointmentId) =>
  (await root.request(`appointments:get?filterByTk=${appointmentId}`)).json?.data?.notes;

// -------------------------------------------------------------------------------------------------------------
// r_staff: the technician role
// -------------------------------------------------------------------------------------------------------------

qaTest('r_staff: the list contains only appointments assigned to the technician', async (ctx) => {
  const { staff } = await getPeople(ctx);
  const { own } = await seed(ctx);
  const response = await staff.request(`appointments:list?paginate=false&filter=${inQaRange}&appends[]=customer`);
  assert.equal(response.status, 200);
  assert.deepEqual(
    rows(response).map((row) => String(row.id)),
    [String(own)],
    "neither the other technician's nor the unassigned appointment",
  );
  const counted = await staff.request(`appointments:list?pageSize=1&filter=${inQaRange}`);
  assert.equal(count(counted), 1, 'the total does not reveal appointments the technician may not see');
});

qaTest("r_staff: GET by id returns an own appointment and nothing for anyone else's", async (ctx) => {
  const { staff } = await getPeople(ctx);
  const { own, foreign, unassigned, customer } = await seed(ctx);
  const mine = body(await staff.request(`appointments:get?filterByTk=${own}&appends[]=customer`)).data;
  assert.ok(mine && sameId(mine.id, own));
  assert.deepEqual(
    mine.customer.skinSensitivities,
    customer.skinSensitivities,
    "the indicator's data arrives with the own appointment",
  );
  for (const [label, appointmentId] of [
    ["another technician's", foreign],
    ['an unassigned', unassigned],
  ]) {
    const response = await staff.request(`appointments:get?filterByTk=${appointmentId}&appends[]=customer`);
    assert.ok(!body(response).data, `${label} appointment must not be readable`);
    assert.ok(!JSON.stringify(body(response)).includes('skinSensitivities'), 'and no customer data comes with it');
  }
});

qaTest("r_staff: can update an own appointment but not another technician's", async (ctx) => {
  const { staff } = await getPeople(ctx);
  const { root } = ctx;
  const { own, foreign } = await seed(ctx);
  assert.equal(
    (await staff.request(`appointments:update?filterByTk=${own}`, { method: 'POST', body: { notes: 'own edit' } }))
      .status,
    200,
  );
  assert.equal(await notesOf(root, own), 'own edit');
  const before = await notesOf(root, foreign);
  await staff.request(`appointments:update?filterByTk=${foreign}`, { method: 'POST', body: { notes: 'tampered' } });
  assert.equal(await notesOf(root, foreign), before, "another technician's appointment must be unchanged");
});

qaTest('r_staff: cannot delete any appointment', async (ctx) => {
  const { staff } = await getPeople(ctx);
  const { root } = ctx;
  const { own, foreign } = await seed(ctx);
  for (const appointmentId of [own, foreign]) {
    const response = await staff.request(`appointments:destroy?filterByTk=${appointmentId}`, { method: 'POST' });
    assert.equal(response.status, 403, 'the technician role has no delete permission');
    assert.ok(
      body(await root.request(`appointments:get?filterByTk=${appointmentId}`)).data,
      'the appointment still exists',
    );
  }
});

qaTest('r_staff: can create an appointment for themselves; columns outside the grant are not stored', async (ctx) => {
  const { staff } = await getPeople(ctx);
  const { root, world, reference } = ctx;
  const response = await staff.request('appointments:create', {
    method: 'POST',
    body: {
      customerId: reference.customers[0].id,
      staffId: staff.staffId,
      appointmentDate: qaDate(13),
      startTime: qaTime(13, 9),
      // import identifiers are not part of the role's field grant
      externalSource: 'qa',
      externalId: 'qa-1',
    },
  });
  assert.equal(response.status, 200);
  const created = id(response);
  world.appointments.push(created);
  const stored = body(await root.request(`appointments:get?filterByTk=${created}`)).data;
  assert.equal(stored.externalId ?? null, null);
  assert.equal(stored.externalSource ?? null, null);
  const visible = rows(await staff.request(`appointments:list?paginate=false&filter=${inQaRange}`));
  assert.ok(
    visible.some((row) => sameId(row.id, created)),
    'the technician sees what they created',
  );
});

qaTest('r_staff: tab and status counts only cover the assigned appointments', async (ctx) => {
  const { staff } = await getPeople(ctx);
  await seed(ctx);
  const filter = (extra) =>
    encode({ $and: [{ appointmentDate: { $gte: '2027-03-01' } }, { appointmentDate: { $lte: '2027-03-31' } }, extra] });
  const sessions = await staff.request(
    `appointments:list?pageSize=1&filter=${filter({ category: { $eq: 'session' } })}`,
  );
  const events = await staff.request(`appointments:list?pageSize=1&filter=${filter({ category: { $eq: 'event' } })}`);
  assert.equal(count(sessions), 1);
  assert.equal(count(events), 0, 'an empty category stays empty for this role');
});

// -------------------------------------------------------------------------------------------------------------
// r_receptionist: front-desk role
// -------------------------------------------------------------------------------------------------------------

qaTest('r_receptionist: sees every appointment and can create, update and delete', async (ctx) => {
  const { receptionist, otherTechnician } = await getPeople(ctx);
  const { root, reference } = ctx;
  const { own, foreign, unassigned } = await seed(ctx);
  const listed = rows(await receptionist.request(`appointments:list?paginate=false&filter=${inQaRange}`));
  for (const appointmentId of [own, foreign, unassigned]) {
    assert.ok(
      listed.some((row) => sameId(row.id, appointmentId)),
      "the front desk sees every technician's appointments",
    );
  }
  assert.ok(body(await receptionist.request(`appointments:get?filterByTk=${foreign}`)).data);

  const created = await receptionist.request('appointments:create', {
    method: 'POST',
    body: {
      customerId: reference.customers[0].id,
      staffId: otherTechnician,
      appointmentDate: qaDate(17),
      startTime: qaTime(17, 9),
    },
  });
  assert.equal(created.status, 200);
  const createdId = id(created);
  assert.equal(
    (
      await receptionist.request(`appointments:update?filterByTk=${createdId}`, {
        method: 'POST',
        body: { notes: 'front desk' },
      })
    ).status,
    200,
  );
  assert.equal(await notesOf(root, createdId), 'front desk');
  assert.equal(
    (await receptionist.request(`appointments:destroy?filterByTk=${createdId}`, { method: 'POST' })).status,
    200,
  );
  assert.ok(!body(await root.request(`appointments:get?filterByTk=${createdId}`)).data, 'the receptionist can delete');
});

// -------------------------------------------------------------------------------------------------------------
// no session
// -------------------------------------------------------------------------------------------------------------

qaTest('unauthenticated requests are refused for every appointment action', async (ctx) => {
  const { apiBase } = require('./support/env');
  const { own } = await seed(ctx);
  const base = apiBase();
  const attempts = [
    ['GET', `appointments:list?pageSize=1`],
    ['GET', `appointments:get?filterByTk=${own}`],
    ['POST', 'appointments:create'],
    ['POST', `appointments:update?filterByTk=${own}`],
    ['POST', `appointments:destroy?filterByTk=${own}`],
  ];
  for (const [method, action] of attempts) {
    const response = await fetch(base + action, {
      method,
      headers: { 'content-type': 'application/json' },
      body: method === 'POST' ? '{}' : undefined,
    });
    assert.equal(response.status, 401, `${method} ${action} must require a session`);
  }
});

// -------------------------------------------------------------------------------------------------------------
// Known gaps. These assert what the acceptance criteria require ("see only appointment data permitted by their staff /
// technician role"); the current grants do not give it, so they are reported as todo until the grants change.
// -------------------------------------------------------------------------------------------------------------

const GAP = 'AUTHZ-GAP: the appointment scope is not applied when appointments are reached through a relation';

qaTest(
  "r_staff cannot read another technician's appointments through a related resource",
  async (ctx) => {
    const { staff, otherTechnician } = await getPeople(ctx);
    const { foreign, customer } = await seed(ctx);
    const reaches = (list) => (list || []).some((row) => sameId(row.id, foreign));
    const leaks = [];

    const viaStaff = body(await staff.request(`staff:get?filterByTk=${otherTechnician}&appends[]=appointments`)).data;
    if (reaches(viaStaff?.appointments)) leaks.push('staff.appointments');

    const viaCustomer = body(await staff.request(`customers:get?filterByTk=${customer.id}&appends[]=appointments`))
      .data;
    if (reaches(viaCustomer?.appointments)) leaks.push('customers.appointments');

    const lines = rows(
      await staff.request(
        `appointmentServices:list?paginate=false&appends[]=appointment&filter=${encode({
          appointmentId: { $eq: foreign },
        })}`,
      ),
    );
    if (lines.length) leaks.push('appointmentServices (lines of the appointment, with the appointment itself)');

    const services = rows(
      await staff.request(
        'services:list?paginate=false&appends[]=appointmentServices&appends[]=appointmentServices.appointment',
      ),
    );
    if (
      services
        .flatMap((service) => service.appointmentServices || [])
        .some((line) => sameId(line.appointmentId, foreign))
    ) {
      leaks.push('services.appointmentServices');
    }
    assert.deepEqual(leaks, [], `another technician's appointment is reachable through: ${leaks.join('; ')}`);
  },
  { todo: GAP },
);

qaTest(
  "r_staff cannot change another technician's booked service lines",
  async (ctx) => {
    const { staff } = await getPeople(ctx);
    const { root } = ctx;
    const { foreign } = await seed(ctx);
    const line = rows(
      await root.request(
        `appointmentServices:list?paginate=false&filter=${encode({ appointmentId: { $eq: foreign } })}`,
      ),
    )[0];
    await staff.request(`appointmentServices:update?filterByTk=${line.id}`, {
      method: 'POST',
      body: { priceAtBooking: 1 },
    });
    const after = body(await root.request(`appointmentServices:get?filterByTk=${line.id}`)).data;
    assert.equal(after.priceAtBooking, 10, "the price of another technician's booked service was changed");
  },
  { todo: GAP },
);

qaTest(
  'every login that holds the technician role defaults to it, so the staff scope applies without switching role',
  async ({ root }) => {
    const users = rows(await root.request('users:list?paginate=false&appends[]=roles'));
    const unsafe = [];
    for (const user of users) {
      const names = (user.roles || []).map((role) => role.name);
      if (!names.includes('r_staff') || user.username.startsWith(QA_USER_PREFIX)) continue;
      const assignments = rows(
        await root.request(`rolesUsers:list?paginate=false&filter=${encode({ userId: user.id })}`),
      );
      const defaultRole = assignments.find((assignment) => assignment.default)?.roleName;
      if (defaultRole !== 'r_staff') unsafe.push(`${user.username} (default role: ${defaultRole})`);
    }
    assert.deepEqual(unsafe, [], `these technician logins open with a broader role: ${unsafe.join(', ')}`);
  },
  { todo: 'AUTHZ-GAP: staff logins also hold the default "member" role, which can read and edit every appointment' },
);
