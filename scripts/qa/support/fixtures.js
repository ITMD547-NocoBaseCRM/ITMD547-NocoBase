// Fixtures for the appointment QA suites (US-26 / T-46).
//
// Everything a suite creates is tracked and removed again, and a sweep at the start and end removes anything an
// interrupted run left behind. Test appointments sit in a date range no real booking uses, so they can be told apart.

const crypto = require('crypto');
const { createClient } = require('../../nocobase-api');

const QA_NOTE = '[QA-T46 temporary - safe to delete]';
const QA_MONTH_START = '2027-03-01';
const QA_MONTH_END = '2027-03-31';
const QA_USER_PREFIX = 'qa_t46_';
const QA_SERVICE_PREFIX = 'QA-T46 ';

const body = (response) => response.json || {};
const rows = (response) => body(response).data || [];
const id = (response) => body(response).data?.id;
const count = (response) => body(response).meta?.count;

async function createRootClient() {
  return createClient();
}

// A date inside the QA range: day is 1..28.
const qaDate = (day) => `2027-03-${String(day).padStart(2, '0')}`;
const qaTime = (day, hour, minute = 0) =>
  `2027-03-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`;

// ---- reference data -------------------------------------------------------------------------------------------

// Real customers, grouped by the shape of their recorded sensitivities (the US-01 demo customers cover each shape).
async function loadReference(root) {
  const customers = rows(await root.request('customers:list?paginate=false'));
  const recorded = (c) => (Array.isArray(c.skinSensitivities) ? c.skinSensitivities.filter(Boolean) : []);
  const shapes = {
    none: customers.filter((c) => recorded(c).length === 0 && !String(c.skinSensitivitiesOther || '').trim()),
    one: customers.filter((c) => recorded(c).length === 1 && !recorded(c).includes('other')),
    multiple: customers.filter((c) => recorded(c).length > 1),
    other: customers.filter((c) => recorded(c).includes('other') && String(c.skinSensitivitiesOther || '').trim()),
  };
  const staff = rows(await root.request('staff:list?paginate=false'));
  const services = rows(await root.request('services:list?paginate=false&filter[active]=true'));
  return { customers, shapes, staff, services };
}

// ---- cleanup --------------------------------------------------------------------------------------------------

// Removes only the appointments in the QA date range (fast); used before every test so counts start from zero.
async function sweepAppointments(root) {
  const filter = encodeURIComponent(
    JSON.stringify({
      $and: [{ appointmentDate: { $gte: QA_MONTH_START } }, { appointmentDate: { $lte: QA_MONTH_END } }],
    }),
  );
  const found = rows(await root.request(`appointments:list?paginate=false&filter=${filter}`));
  for (const row of found) await root.request(`appointments:destroy?filterByTk=${row.id}`, { method: 'POST' });
  return found.length;
}

async function sweep(root) {
  // appointments created by QA runs (the date range is outside any real booking)
  const filter = encodeURIComponent(
    JSON.stringify({
      $and: [{ appointmentDate: { $gte: QA_MONTH_START } }, { appointmentDate: { $lte: QA_MONTH_END } }],
    }),
  );
  const found = rows(await root.request(`appointments:list?paginate=false&filter=${filter}`));
  for (const row of found) await root.request(`appointments:destroy?filterByTk=${row.id}`, { method: 'POST' });

  // temporary users and the staff rows linked to them
  const users = rows(await root.request(`users:list?paginate=false&filter[username][$includes]=${QA_USER_PREFIX}`));
  for (const user of users) {
    const linked = rows(await root.request(`staff:list?paginate=false&filter[userId]=${user.id}`));
    for (const staff of linked) await root.request(`staff:destroy?filterByTk=${staff.id}`, { method: 'POST' });
    await root.request(`users:destroy?filterByTk=${user.id}`, { method: 'POST' });
  }
  // temporary customers and services (created by the integrity tests)
  const tempCustomers = rows(await root.request('customers:list?paginate=false&filter[lastName]=QA-T46'));
  const tempServices = rows(
    await root.request(`services:list?paginate=false&filter[name][$includes]=${QA_SERVICE_PREFIX}`),
  );
  const orphanStaff = rows(await root.request('staff:list?paginate=false&filter[lastName]=QA-T46'));
  for (const staff of orphanStaff) await root.request(`staff:destroy?filterByTk=${staff.id}`, { method: 'POST' });
  for (const customer of tempCustomers)
    await root.request(`customers:destroy?filterByTk=${customer.id}`, { method: 'POST' });
  for (const service of tempServices)
    await root.request(`services:destroy?filterByTk=${service.id}`, { method: 'POST' });
  return found.length + users.length + orphanStaff.length + tempCustomers.length + tempServices.length;
}

// ---- tracked creation ----------------------------------------------------------------------------------------

class World {
  constructor(root) {
    this.root = root;
    this.appointments = [];
    this.staff = [];
    this.users = [];
    this.customers = [];
    this.services = [];
  }

  async createAppointment(values = {}) {
    const response = await this.root.request('appointments:create', {
      method: 'POST',
      // The database derives the date from the start time, so a test that names a date also gets a start time on it.
      body: {
        notes: QA_NOTE,
        ...values,
        appointmentDate: values.appointmentDate ?? qaDate(15),
        startTime:
          values.startTime ?? (values.appointmentDate ? `${values.appointmentDate}T15:00:00.000Z` : qaTime(15, 9)),
      },
    });
    const created = id(response);
    if (created) this.appointments.push(created);
    return { response, id: created, data: body(response).data };
  }

  async createStaff(values = {}) {
    const suffix = crypto.randomBytes(3).toString('hex');
    const response = await this.root.request('staff:create', {
      method: 'POST',
      body: { firstName: `QA${suffix}`, lastName: 'QA-T46', role: 'stylist', active: 'active', ...values },
    });
    const created = id(response);
    if (created) this.staff.push(created);
    return { response, id: created };
  }

  async createCustomer(values = {}) {
    const suffix = crypto.randomBytes(3).toString('hex');
    const response = await this.root.request('customers:create', {
      method: 'POST',
      body: { firstName: `QA${suffix}`, lastName: 'QA-T46', status: 'active', ...values },
    });
    const created = id(response);
    if (created) this.customers.push(created);
    return { response, id: created };
  }

  async createService(values = {}) {
    const response = await this.root.request('services:create', {
      method: 'POST',
      body: {
        name: `${QA_SERVICE_PREFIX}${crypto.randomBytes(3).toString('hex')}`,
        price: 1,
        durationMinutes: 10,
        active: false,
        ...values,
      },
    });
    const created = id(response);
    if (created) this.services.push(created);
    return { response, id: created };
  }

  // A temporary user holding exactly one role, optionally linked to a staff row (which is what the staff scope reads).
  async createRoleUser(role, { linkStaff = true } = {}) {
    const username = QA_USER_PREFIX + crypto.randomBytes(4).toString('hex');
    const password = crypto.randomBytes(12).toString('base64url') + 'Aa1!';
    const created = await this.root.request('users:create', {
      method: 'POST',
      body: { username, nickname: 'QA T46', password, roles: [role] },
    });
    const userId = id(created);
    if (!userId) throw new Error(`could not create the ${role} QA user (status ${created.status})`);
    this.users.push(userId);
    let staffId = null;
    if (linkStaff) {
      const staff = await this.createStaff({ userId });
      staffId = staff.id;
    }
    const signIn = await this.root.request('auth:signIn', { method: 'POST', body: { account: username, password } });
    const token = body(signIn).data?.token;
    if (!token) throw new Error(`the ${role} QA user could not sign in (status ${signIn.status})`);
    const client = await createClient({ token });
    return {
      role,
      userId,
      staffId,
      username,
      // Every request names the role explicitly, as the app does when the user switches role.
      request: (action, options = {}) =>
        client.request(action, { ...options, headers: { 'X-Role': role, ...(options.headers || {}) } }),
    };
  }

  async cleanup() {
    for (const appointment of this.appointments) {
      await this.root.request(`appointments:destroy?filterByTk=${appointment}`, { method: 'POST' });
    }
    for (const customer of this.customers)
      await this.root.request(`customers:destroy?filterByTk=${customer}`, { method: 'POST' });
    for (const service of this.services)
      await this.root.request(`services:destroy?filterByTk=${service}`, { method: 'POST' });
    for (const staff of this.staff) await this.root.request(`staff:destroy?filterByTk=${staff}`, { method: 'POST' });
    for (const user of this.users) await this.root.request(`users:destroy?filterByTk=${user}`, { method: 'POST' });
    return sweep(this.root);
  }
}

module.exports = {
  QA_MONTH_END,
  QA_MONTH_START,
  QA_NOTE,
  QA_SERVICE_PREFIX,
  QA_USER_PREFIX,
  World,
  body,
  count,
  createRootClient,
  id,
  loadReference,
  qaDate,
  qaTime,
  rows,
  sweep,
  sweepAppointments,
};
