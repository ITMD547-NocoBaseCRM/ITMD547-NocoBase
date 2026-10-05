// Integration tests for appointment management over the real REST API (US-26 / T-46).
//
// Needs a running local NocoBase app; every test skips with a reason otherwise. Rows are created in a date range no
// real booking uses and are removed afterwards. Run with: yarn test:appointments-qa-api

const assert = require('node:assert/strict');
const { getCategoryFilter } = require('../appointments-schema');
const { isRejected, qaTest } = require('./support/harness');
const { QA_MONTH_END, QA_MONTH_START, body, count, id, qaDate, qaTime, rows, sweep } = require('./support/fixtures');

const encode = (value) => encodeURIComponent(JSON.stringify(value));
const inQaRange = (...extra) => ({
  $and: [{ appointmentDate: { $gte: QA_MONTH_START } }, { appointmentDate: { $lte: QA_MONTH_END } }, ...extra],
});
const qaCount = async (root, ...extra) =>
  count(await root.request(`appointments:list?pageSize=1&filter=${encode(inQaRange(...extra))}`));
const qaRows = async (root, ...extra) =>
  rows(await root.request(`appointments:list?paginate=false&filter=${encode(inQaRange(...extra))}`));

const get = async (root, appointmentId) =>
  body(
    await root.request(
      // a nested append alone returns only the related service; the line's own columns need their own append
      `appointments:get?filterByTk=${appointmentId}&appends[]=customer&appends[]=staff&appends[]=appointmentServices&appends[]=appointmentServices.service`,
    ),
  ).data;

// -------------------------------------------------------------------------------------------------------------
// CREATE
// -------------------------------------------------------------------------------------------------------------

qaTest(
  'create: a valid appointment is stored with defaults, relations and service lines',
  async ({ root, world, reference }) => {
    const customer = reference.customers[0];
    const staff = reference.staff[0];
    const service = reference.services[0];
    const { response, id: created } = await world.createAppointment({
      customerId: customer.id,
      staffId: staff.id,
      endTime: qaTime(15, 10),
      appointmentServices: [
        { serviceId: service.id, priceAtBooking: service.price, durationAtBooking: service.durationMinutes },
      ],
    });
    assert.equal(response.status, 200);
    const stored = await get(root, created);
    assert.equal(stored.category, 'session', 'category defaults to session');
    assert.equal(stored.status, 'scheduled', 'status defaults to scheduled');
    assert.equal(String(stored.customer.id), String(customer.id));
    assert.equal(String(stored.staff.id), String(staff.id));
    assert.equal(stored.appointmentServices.length, 1);
    assert.equal(String(stored.appointmentServices[0].service.id), String(service.id));
    assert.equal(stored.appointmentServices[0].priceAtBooking, service.price);
    assert.equal(stored.appointmentServices[0].durationAtBooking, service.durationMinutes);
    assert.equal(stored.appointmentDate, qaDate(15));
  },
);

qaTest('create: an Event is valid and every status is accepted', async ({ world, reference }) => {
  const customerId = reference.customers[0].id;
  const event = await world.createAppointment({ customerId, category: 'event', appointmentDate: qaDate(2) });
  assert.equal(event.response.status, 200);
  assert.equal(event.data.category, 'event');
  for (const status of ['scheduled', 'confirmed', 'inProgress', 'completed', 'cancelled', 'noShow']) {
    const made = await world.createAppointment({ customerId, status, appointmentDate: qaDate(3) });
    assert.equal(made.response.status, 200, `status ${status} must be accepted`);
  }
});

qaTest('create: technician and end time are optional', async ({ world, reference }) => {
  const { response, data } = await world.createAppointment({ customerId: reference.customers[0].id });
  assert.equal(response.status, 200);
  assert.equal(data.staffId ?? null, null, 'an unassigned appointment is allowed');
  assert.equal(data.endTime ?? null, null);
});

qaTest(
  'create: required fields are enforced and nothing is stored when one is missing',
  async ({ root, reference }) => {
    const customerId = reference.customers[0].id;
    const base = { customerId, appointmentDate: qaDate(4), startTime: qaTime(4, 9), notes: 'QA required' };
    const before = await qaCount(root);
    for (const missing of ['customerId', 'startTime']) {
      const values = { ...base };
      delete values[missing];
      const response = await root.request('appointments:create', { method: 'POST', body: values });
      assert.ok(isRejected(response), `creating without ${missing} must be rejected (got ${response.status})`);
    }
    for (const nullable of ['status', 'category']) {
      const response = await root.request('appointments:create', {
        method: 'POST',
        body: { ...base, [nullable]: null },
      });
      assert.ok(isRejected(response), `an explicit null ${nullable} must be rejected (got ${response.status})`);
    }
    assert.equal(await qaCount(root), before, 'rejected requests must not leave rows behind');
  },
);

qaTest('create: invalid category and status values are rejected', async ({ root, reference }) => {
  const base = { customerId: reference.customers[0].id, appointmentDate: qaDate(5), startTime: qaTime(5, 9) };
  assert.ok(
    isRejected(await root.request('appointments:create', { method: 'POST', body: { ...base, category: 'party' } })),
  );
  assert.ok(
    isRejected(await root.request('appointments:create', { method: 'POST', body: { ...base, status: 'done' } })),
  );
  assert.equal(await qaCount(root), 0);
});

qaTest('create: invalid date and time combinations are rejected', async ({ root, reference }) => {
  const base = { customerId: reference.customers[0].id, appointmentDate: qaDate(6), startTime: qaTime(6, 10) };
  const invalid = {
    'end before start': { endTime: qaTime(6, 9) },
    'end equal to start': { endTime: qaTime(6, 10) },
    'unparseable end': { endTime: 'not-a-time' },
    'unparseable start': { startTime: 'later' },
    'impossible date': { appointmentDate: '2027-13-45' },
    'text date': { appointmentDate: 'tomorrow' },
  };
  for (const [label, override] of Object.entries(invalid)) {
    const response = await root.request('appointments:create', { method: 'POST', body: { ...base, ...override } });
    assert.ok(isRejected(response), `${label} must be rejected (got ${response.status})`);
  }
  assert.equal(await qaCount(root), 0);
  // the boundary just inside the rule is valid
  const ok = await root.request('appointments:create', {
    method: 'POST',
    body: { ...base, endTime: qaTime(6, 10, 1) },
  });
  assert.equal(ok.status, 200);
  await root.request(`appointments:destroy?filterByTk=${id(ok)}`, { method: 'POST' });
});

qaTest(
  'create: references to a customer, technician or service that does not exist are rejected',
  async ({ root, reference }) => {
    const base = { customerId: reference.customers[0].id, appointmentDate: qaDate(7), startTime: qaTime(7, 9) };
    const missingId = '999999999999999999';
    const dangling = {
      'missing customer': { ...base, customerId: missingId },
      'missing technician': { ...base, staffId: missingId },
      'missing service': {
        ...base,
        appointmentServices: [{ serviceId: missingId, priceAtBooking: 10, durationAtBooking: 30 }],
      },
    };
    const accepted = [];
    for (const [label, values] of Object.entries(dangling)) {
      const response = await root.request('appointments:create', { method: 'POST', body: values });
      if (!isRejected(response)) accepted.push(label);
      if (id(response)) await root.request(`appointments:destroy?filterByTk=${id(response)}`, { method: 'POST' });
    }
    assert.deepEqual(
      accepted,
      [],
      `dangling references were accepted and would corrupt the appointment: ${accepted.join(', ')}`,
    );
    assert.equal(await qaCount(root), 0);
  },
);

qaTest('create: the appointment date is created from the start time', async ({ root, world, reference }) => {
  const customerId = reference.customers[0].id;
  // no date supplied at all
  const plain = await world.createAppointment({ customerId, startTime: qaTime(8, 15), appointmentDate: undefined });
  assert.equal(plain.response.status, 200);
  assert.equal((await get(root, plain.id)).appointmentDate, qaDate(8));

  // 9 pm in Chicago (CDT) is already the next day in UTC: the salon's calendar date is kept
  const evening = await world.createAppointment({
    customerId,
    startTime: '2027-03-19T02:00:00.000Z',
    appointmentDate: undefined,
  });
  assert.equal((await get(root, evening.id)).appointmentDate, '2027-03-18');

  // a supplied date never overrides the start time
  const wrong = await world.createAppointment({ customerId, startTime: qaTime(9, 15), appointmentDate: qaDate(1) });
  assert.equal((await get(root, wrong.id)).appointmentDate, qaDate(9));

  // an appointment that runs past midnight keeps the date it started on
  const overnight = await world.createAppointment({
    customerId,
    startTime: '2027-03-12T04:30:00.000Z',
    endTime: '2027-03-12T06:30:00.000Z',
    appointmentDate: undefined,
  });
  assert.equal((await get(root, overnight.id)).appointmentDate, '2027-03-11');
});

qaTest(
  'update: the date follows the start time, and a hand-edited date is put right',
  async ({ root, world, reference }) => {
    const { id: created } = await world.createAppointment({
      customerId: reference.customers[0].id,
      startTime: qaTime(10, 15),
      appointmentDate: undefined,
    });
    assert.equal((await get(root, created)).appointmentDate, qaDate(10));

    await update(root, created, { startTime: qaTime(11, 15) });
    assert.equal((await get(root, created)).appointmentDate, qaDate(11), 'moving the start time moves the date');

    await update(root, created, { appointmentDate: qaDate(1) });
    assert.equal((await get(root, created)).appointmentDate, qaDate(11), 'a date edited on its own is corrected');

    // clearing the date is not an error: it is simply put back from the start time
    assert.equal((await update(root, created, { appointmentDate: null })).status, 200);
    assert.equal((await get(root, created)).appointmentDate, qaDate(11), 'a cleared date is restored');

    await update(root, created, { notes: 'unrelated change' });
    assert.equal((await get(root, created)).appointmentDate, qaDate(11), 'other edits leave it alone');
  },
);

// -------------------------------------------------------------------------------------------------------------
// READ
// -------------------------------------------------------------------------------------------------------------

qaTest('read: list paginates, sorts and returns relations', async ({ root, world, reference }) => {
  const customerId = reference.customers[0].id;
  for (const day of [10, 11, 12])
    await world.createAppointment({ customerId, appointmentDate: qaDate(day), startTime: qaTime(day, 9) });
  const page = await root.request(
    `appointments:list?pageSize=2&page=1&sort[]=-appointmentDate&appends[]=customer&filter=${encode(inQaRange())}`,
  );
  assert.equal(page.status, 200);
  assert.equal(count(page), 3);
  const data = rows(page);
  assert.equal(data.length, 2, 'the page size is honoured');
  assert.deepEqual(
    data.map((row) => row.appointmentDate),
    [qaDate(12), qaDate(11)],
    'newest date first',
  );
  assert.ok(
    data.every((row) => row.customer && row.customer.firstName !== undefined),
    'the customer arrives with the row',
  );
  const second = rows(
    await root.request(`appointments:list?pageSize=2&page=2&sort[]=-appointmentDate&filter=${encode(inQaRange())}`),
  );
  assert.deepEqual(
    second.map((row) => row.appointmentDate),
    [qaDate(10)],
  );
});

qaTest('read: details by id include the customer, technician and service lines', async ({ root, world, reference }) => {
  const service = reference.services[0];
  const { id: created } = await world.createAppointment({
    customerId: reference.customers[0].id,
    staffId: reference.staff[0].id,
    appointmentServices: [{ serviceId: service.id, priceAtBooking: 55, durationAtBooking: 40 }],
  });
  const details = await get(root, created);
  assert.ok(details.customer && details.staff && details.appointmentServices[0].service.name);
  assert.equal(details.appointmentServices[0].priceAtBooking, 55);
});

qaTest('read: a missing or deleted appointment yields no record, not a crash', async ({ root, world, reference }) => {
  const never = await root.request('appointments:get?filterByTk=999999999999999999');
  assert.ok(isRejected(never) || body(never).data === null || body(never).data === undefined);

  const { id: created } = await world.createAppointment({ customerId: reference.customers[0].id });
  await root.request(`appointments:destroy?filterByTk=${created}`, { method: 'POST' });
  const gone = await root.request(`appointments:get?filterByTk=${created}`);
  assert.ok(isRejected(gone) || !body(gone).data, 'a deleted appointment must not be returned');
});

qaTest('read: an empty result is an empty list with a zero count', async ({ root }) => {
  const response = await root.request(`appointments:list?pageSize=20&filter=${encode(inQaRange())}`);
  assert.equal(response.status, 200);
  assert.deepEqual(rows(response), []);
  assert.equal(count(response), 0);
});

// -------------------------------------------------------------------------------------------------------------
// UPDATE
// -------------------------------------------------------------------------------------------------------------

// Like the app's form submit: nested booked-service edits are only applied when the association is named.
async function update(root, appointmentId, values) {
  return root.request(`appointments:update?filterByTk=${appointmentId}&updateAssociationValues[]=appointmentServices`, {
    method: 'POST',
    body: values,
  });
}

qaTest(
  'update: customer, category, status, date and time, technician and notes each persist',
  async ({ root, world, reference }) => {
    const [first, second] = reference.customers;
    const [staffA, staffB] = reference.staff;
    const { id: created } = await world.createAppointment({
      customerId: first.id,
      staffId: staffA.id,
      endTime: qaTime(15, 10),
    });

    assert.equal((await update(root, created, { customerId: second.id })).status, 200);
    assert.equal(String((await get(root, created)).customer.id), String(second.id));

    assert.equal((await update(root, created, { category: 'event' })).status, 200);
    assert.equal((await get(root, created)).category, 'event');

    assert.equal((await update(root, created, { status: 'confirmed' })).status, 200);
    assert.equal((await get(root, created)).status, 'confirmed');

    assert.equal(
      (await update(root, created, { appointmentDate: qaDate(16), startTime: qaTime(16, 13), endTime: qaTime(16, 14) }))
        .status,
      200,
    );
    const moved = await get(root, created);
    assert.equal(moved.appointmentDate, qaDate(16));
    assert.equal(new Date(moved.startTime).toISOString(), qaTime(16, 13));

    assert.equal((await update(root, created, { staffId: staffB.id })).status, 200);
    assert.equal(String((await get(root, created)).staff.id), String(staffB.id));
    assert.equal((await update(root, created, { staffId: null })).status, 200, 'a technician can be unassigned');
    assert.equal((await get(root, created)).staff ?? null, null);

    assert.equal((await update(root, created, { notes: 'Updated by QA' })).status, 200);
    assert.equal((await get(root, created)).notes, 'Updated by QA');
  },
);

qaTest(
  'update: booked services can be replaced, and removed lines do not linger as orphans',
  async ({ root, world, reference }) => {
    const [serviceA, serviceB] = reference.services;
    const { id: created } = await world.createAppointment({
      customerId: reference.customers[0].id,
      appointmentServices: [
        { serviceId: serviceA.id, priceAtBooking: 10, durationAtBooking: 30 },
        { serviceId: serviceB.id, priceAtBooking: 20, durationAtBooking: 45 },
      ],
    });
    const before = (await get(root, created)).appointmentServices;
    assert.equal(before.length, 2);
    const orphansBefore = count(
      await root.request(`appointmentServices:list?pageSize=1&filter=${encode({ appointmentId: { $empty: true } })}`),
    );

    // what the edit form sends after the user removes one line: the remaining line only
    const keep = before.find((line) => String(line.serviceId) === String(serviceA.id));
    const response = await update(root, created, {
      appointmentServices: [{ id: keep.id, serviceId: serviceA.id, priceAtBooking: 11, durationAtBooking: 31 }],
    });
    assert.equal(response.status, 200);
    const after = (await get(root, created)).appointmentServices;
    assert.equal(after.length, 1);
    assert.equal(after[0].priceAtBooking, 11);

    const orphansAfter = count(
      await root.request(`appointmentServices:list?pageSize=1&filter=${encode({ appointmentId: { $empty: true } })}`),
    );
    if (orphansAfter > orphansBefore) {
      // restore the database before failing
      const orphans = rows(
        await root.request(
          `appointmentServices:list?paginate=false&filter=${encode({ appointmentId: { $empty: true } })}`,
        ),
      );
      for (const line of orphans)
        await root.request(`appointmentServices:destroy?filterByTk=${line.id}`, { method: 'POST' });
    }
    assert.equal(orphansAfter, orphansBefore, 'removing a service line left an orphan appointmentServices row');
  },
);

qaTest(
  'update: invalid changes are rejected and leave the appointment unchanged',
  async ({ root, world, reference }) => {
    const { id: created } = await world.createAppointment({
      customerId: reference.customers[0].id,
      endTime: qaTime(15, 10),
    });
    const invalid = {
      'end before start': { endTime: qaTime(15, 8) },
      'invalid status': { status: 'done' },
      'invalid category': { category: 'party' },
      'cleared customer': { customerId: null },
      'cleared start': { startTime: null },
    };
    for (const [label, values] of Object.entries(invalid)) {
      assert.ok(isRejected(await update(root, created, values)), `${label} must be rejected`);
    }
    const unchanged = await get(root, created);
    assert.equal(unchanged.status, 'scheduled');
    assert.equal(unchanged.category, 'session');
    assert.equal(new Date(unchanged.endTime).toISOString(), qaTime(15, 10));
  },
);

qaTest('update: an appointment that no longer exists cannot be changed', async ({ root, world, reference }) => {
  const { id: created } = await world.createAppointment({ customerId: reference.customers[0].id });
  await root.request(`appointments:destroy?filterByTk=${created}`, { method: 'POST' });
  const response = await update(root, created, { notes: 'too late' });
  const touched = body(response).data;
  assert.ok(
    isRejected(response) || !touched || (Array.isArray(touched) && touched.length === 0),
    'updating a deleted appointment must change nothing',
  );
  assert.equal((await root.request(`appointments:get?filterByTk=${created}`)).json?.data ?? null, null);
});

// -------------------------------------------------------------------------------------------------------------
// DELETE
// -------------------------------------------------------------------------------------------------------------

qaTest(
  'delete: removes the appointment and its booked services, and is safe to repeat',
  async ({ root, world, reference }) => {
    const service = reference.services[0];
    const { id: created } = await world.createAppointment({
      customerId: reference.customers[0].id,
      appointmentServices: [{ serviceId: service.id, priceAtBooking: 10, durationAtBooking: 30 }],
    });
    const lines = (await get(root, created)).appointmentServices;
    assert.equal(lines.length, 1);

    assert.equal((await root.request(`appointments:destroy?filterByTk=${created}`, { method: 'POST' })).status, 200);
    assert.ok(!body(await root.request(`appointments:get?filterByTk=${created}`)).data, 'the appointment is gone');
    const remaining = count(
      await root.request(`appointmentServices:list?pageSize=1&filter=${encode({ appointmentId: created })}`),
    );
    assert.equal(remaining, 0, 'booked-service lines are deleted with the appointment');
    const orphanLine = body(await root.request(`appointmentServices:get?filterByTk=${lines[0].id}`)).data;
    assert.ok(!orphanLine, 'the booked-service row itself is gone');

    const again = await root.request(`appointments:destroy?filterByTk=${created}`, { method: 'POST' });
    assert.ok(again.status < 500, 'deleting twice must not be a server error');
  },
);

qaTest('delete: a customer with appointments cannot be deleted, so the history is kept', async ({ root, world }) => {
  const customer = await world.createCustomer();
  const { id: created } = await world.createAppointment({ customerId: customer.id });
  const refused = await root.request(`customers:destroy?filterByTk=${customer.id}`, { method: 'POST' });
  assert.ok(isRejected(refused), `deleting a customer who has appointments must be refused (got ${refused.status})`);
  assert.ok((await get(root, created)).customer, 'the appointment still has its customer');

  await root.request(`appointments:destroy?filterByTk=${created}`, { method: 'POST' });
  const allowed = await root.request(`customers:destroy?filterByTk=${customer.id}`, { method: 'POST' });
  assert.equal(allowed.status, 200, 'a customer without appointments can be deleted');
});

qaTest('delete: removing a technician leaves their appointments, unassigned', async ({ root, world, reference }) => {
  const technician = await world.createStaff();
  const { id: created } = await world.createAppointment({
    customerId: reference.customers[0].id,
    staffId: technician.id,
  });
  assert.equal((await root.request(`staff:destroy?filterByTk=${technician.id}`, { method: 'POST' })).status, 200);
  const appointment = await get(root, created);
  assert.ok(appointment, 'the appointment survives');
  assert.equal(appointment.staffId ?? null, null, 'and is unassigned');
});

qaTest('delete: a service that has been booked cannot be deleted', async ({ root, world, reference }) => {
  const service = await world.createService();
  const { id: created } = await world.createAppointment({
    customerId: reference.customers[0].id,
    appointmentServices: [{ serviceId: service.id, priceAtBooking: 1, durationAtBooking: 10 }],
  });
  const refused = await root.request(`services:destroy?filterByTk=${service.id}`, { method: 'POST' });
  assert.ok(isRejected(refused), `deleting a booked service must be refused (got ${refused.status})`);
  assert.equal((await get(root, created)).appointmentServices.length, 1, 'the booked line keeps its service');
});

qaTest(
  'errors: refusals are explained in plain language, without database internals',
  async ({ root, world, reference }) => {
    const messageOf = (response) => String((body(response).errors || [])[0]?.message || '');
    const internals = /check constraint|violates|foreign key|relation "|appointments_|_fk|duplicate key/i;

    const backwards = await root.request('appointments:create', {
      method: 'POST',
      body: { customerId: reference.customers[0].id, startTime: qaTime(10, 10), endTime: qaTime(10, 9) },
    });
    assert.ok(isRejected(backwards));
    assert.equal(messageOf(backwards), 'The end time must be after the start time.');

    const customer = await world.createCustomer();
    await world.createAppointment({ customerId: customer.id });
    const keepCustomer = await root.request(`customers:destroy?filterByTk=${customer.id}`, { method: 'POST' });
    assert.ok(isRejected(keepCustomer));
    assert.match(messageOf(keepCustomer), /customer has appointments and cannot be deleted/i);
    assert.ok(!internals.test(messageOf(keepCustomer)), messageOf(keepCustomer));

    const service = await world.createService();
    await world.createAppointment({
      customerId: reference.customers[0].id,
      appointmentServices: [{ serviceId: service.id, priceAtBooking: 1, durationAtBooking: 10 }],
    });
    const keepService = await root.request(`services:destroy?filterByTk=${service.id}`, { method: 'POST' });
    assert.ok(isRejected(keepService));
    assert.match(messageOf(keepService), /service has been booked on appointments and cannot be deleted/i);
    assert.ok(!internals.test(messageOf(keepService)), messageOf(keepService));
  },
);

// -------------------------------------------------------------------------------------------------------------
// FILTERS: the exact requests the toolbar tabs send
// -------------------------------------------------------------------------------------------------------------

qaTest(
  'filters: All, Sessions and Events count correctly, an empty category is zero, and CRUD moves records',
  async ({ root, world, reference }) => {
    const customerId = reference.customers[0].id;
    const tabCount = async (tab) => qaCount(root, getCategoryFilter(tab));

    assert.deepEqual(
      [await tabCount('all'), await tabCount('sessions'), await tabCount('events')],
      [0, 0, 0],
      'an empty database range',
    );

    const s1 = await world.createAppointment({ customerId, appointmentDate: qaDate(20) });
    await world.createAppointment({ customerId, appointmentDate: qaDate(21) });
    assert.deepEqual(
      [await tabCount('all'), await tabCount('sessions'), await tabCount('events')],
      [2, 2, 0],
      'Events is empty, not missing',
    );

    const event = await world.createAppointment({ customerId, appointmentDate: qaDate(22), category: 'event' });
    assert.deepEqual(
      [await tabCount('all'), await tabCount('sessions'), await tabCount('events')],
      [3, 2, 1],
      'a new Event lands in Events',
    );
    assert.deepEqual(
      (await qaRows(root, getCategoryFilter('events'))).map((row) => String(row.id)),
      [String(event.id)],
    );

    await update(root, s1.id, { category: 'event' });
    assert.deepEqual(
      [await tabCount('all'), await tabCount('sessions'), await tabCount('events')],
      [3, 1, 2],
      'an edited category moves tabs',
    );

    await root.request(`appointments:destroy?filterByTk=${event.id}`, { method: 'POST' });
    assert.deepEqual(
      [await tabCount('all'), await tabCount('sessions'), await tabCount('events')],
      [2, 1, 1],
      'a deleted record leaves its tab',
    );

    // a tab combines with the status filter the way the KPI tiles do
    const combined = await qaCount(root, getCategoryFilter('events'), { status: { $eq: 'scheduled' } });
    assert.equal(combined, 1);
    assert.equal(await qaCount(root, getCategoryFilter('events'), { status: { $eq: 'completed' } }), 0);
  },
);

// -------------------------------------------------------------------------------------------------------------
// SENSITIVITIES: the data the indicator reads (Appointment -> Customer -> Skin sensitivities)
// -------------------------------------------------------------------------------------------------------------

qaTest('sensitivities: the field metadata is the US-01 schema', async ({ root }) => {
  const field = body(await root.request('collections/customers/fields:get?filterByTk=skinSensitivities')).data;
  assert.equal(field.interface, 'multipleSelect');
  assert.deepEqual(
    (field.options?.enum || field.enum).map((option) => [option.value, option.label]),
    [
      ['fragrancesPerfumes', 'Fragrances & Perfumes'],
      ['essentialOils', 'Essential Oils'],
      ['alphaHydroxyAcids', 'Alpha Hydroxy Acids (AHAs)'],
      ['betaHydroxyAcidsSalicylicAcid', 'Beta Hydroxy Acids (BHAs) / Salicylic Acid'],
      ['retinoidsRetinol', 'Retinoids / Retinol'],
      ['latex', 'Latex'],
      ['nutsSeedOils', 'Nuts & Seed Oils'],
      ['sunExposureSunburn', 'Sun Exposure / Sunburn'],
      ['other', 'Other'],
    ],
  );
});

qaTest(
  'sensitivities: none, one, several and Other reach the appointment through its customer only',
  async ({ root, world, reference }) => {
    const { shapes } = reference;
    for (const shape of ['none', 'one', 'multiple', 'other']) {
      assert.ok(shapes[shape].length > 0, `the US-01 demo data has no customer with ${shape} recorded sensitivities`);
    }
    const check = async (customer) => {
      const { id: created } = await world.createAppointment({ customerId: customer.id });
      const appointment = await get(root, created);
      assert.ok(!('skinSensitivities' in appointment), 'sensitivities are never copied onto the appointment');
      assert.ok(!('skinSensitivitiesOther' in appointment));
      assert.deepEqual(appointment.customer.skinSensitivities ?? null, customer.skinSensitivities ?? null);
      assert.equal(appointment.customer.skinSensitivitiesOther ?? null, customer.skinSensitivitiesOther ?? null);
      return appointment.customer;
    };
    const none = await check(shapes.none[0]);
    assert.ok(!none.skinSensitivities || none.skinSensitivities.length === 0, 'none recorded stays empty (null or [])');
    assert.equal((await check(shapes.one[0])).skinSensitivities.length, 1);
    assert.ok((await check(shapes.multiple[0])).skinSensitivities.length > 1);
    const other = await check(shapes.other[0]);
    assert.ok(other.skinSensitivities.includes('other') && other.skinSensitivitiesOther.trim().length > 0);
  },
);

qaTest(
  "sensitivities: a customer's current record is what the appointment shows, with no stale copy",
  async ({ root, world, reference }) => {
    const customer = reference.shapes.one[0];
    const { id: created } = await world.createAppointment({ customerId: customer.id });
    const original = customer.skinSensitivities;
    try {
      await root.request(`customers:update?filterByTk=${customer.id}`, {
        method: 'POST',
        body: { skinSensitivities: ['latex', 'essentialOils'] },
      });
      // the server returns multi-select values in the field's option order, so compare as sets
      assert.deepEqual([...(await get(root, created)).customer.skinSensitivities].sort(), ['essentialOils', 'latex']);
    } finally {
      await root.request(`customers:update?filterByTk=${customer.id}`, {
        method: 'POST',
        body: { skinSensitivities: original },
      });
    }
    assert.deepEqual((await get(root, created)).customer.skinSensitivities, original);
  },
);

qaTest('cleanup: the QA data range is empty again', async ({ root }) => {
  await sweep(root);
  assert.equal(await qaCount(root), 0);
});
