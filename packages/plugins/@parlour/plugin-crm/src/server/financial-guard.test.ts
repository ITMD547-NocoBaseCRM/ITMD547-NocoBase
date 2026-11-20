// Unit tests for the Staff financial-data guard (no database: a small fake of the CRM schema).
// Run: yarn test:financial-guard
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FINANCIAL,
  checkRequest,
  dropFinancialValues,
  financialGuard,
  financialStep,
  isFinanciallyRestricted,
  stripFinancial,
} from './financial-guard';

const schema: Record<string, Record<string, string | null>> = {
  appointments: { id: null, status: null, staffId: null, startTime: null, customer: 'customers', staff: 'staff', appointmentServices: 'appointmentServices', payments: 'payments' },
  appointmentServices: { id: null, serviceId: null, priceAtBooking: null, appointment: 'appointments', service: 'services' },
  services: { id: null, name: null, price: null, staff: 'staff' },
  customers: { id: null, firstName: null, totalSpent: null, payments: 'payments', appointments: 'appointments', activity: 'customerActivity' },
  customerActivity: { id: null, totalVisits: null, totalSpent: null, spentLast12m: null, customer: 'customers' },
  payments: { id: null, amount: null, appointment: 'appointments' },
  staff: { id: null, firstName: null },
  employeeShifts: { id: null, status: null, staff: 'staff' },
};
const db = {
  getCollection: (name: string) =>
    schema[name] && {
      name,
      getField: (f: string) => (f in schema[name] ? { name: f, target: schema[name][f] || undefined } : undefined),
    },
};

test('who is restricted', () => {
  assert.equal(isFinanciallyRestricted(['staff']), true);
  assert.equal(isFinanciallyRestricted(['member']), true);
  assert.equal(isFinanciallyRestricted([]), true);
  assert.equal(isFinanciallyRestricted(['staff', 'member']), true);
  for (const r of ['admin', 'manager', 'root', 'receptionist']) assert.equal(isFinanciallyRestricted([r]), false, r);
  assert.equal(isFinanciallyRestricted(['staff', 'manager']), false);
});

test('financial paths through associations', () => {
  assert.equal(financialStep(db, 'payments', []), 'payments');
  assert.equal(financialStep(db, 'appointments', ['payments', 'amount']), 'appointments.payments');
  assert.equal(financialStep(db, 'appointments', ['appointmentServices', 'priceAtBooking']), 'appointmentServices.priceAtBooking');
  assert.equal(financialStep(db, 'appointments', ['customer', 'activity', 'spentLast12m']), 'customerActivity.spentLast12m');
  assert.equal(financialStep(db, 'appointmentServices', ['appointment', 'customer', 'totalSpent']), 'customers.totalSpent');
  assert.equal(financialStep(db, 'appointments', ['appointmentServices', 'service', 'name']), null);
  assert.equal(financialStep(db, 'appointments', ['status']), null);
  assert.equal(financialStep(db, 'appointments', ['nope', 'payments']), null);
});

test('financial tables and association resources are refused', () => {
  assert.ok(checkRequest(db, 'payments', 'list', {}));
  assert.ok(checkRequest(db, 'payments', 'query', { values: { measures: [{ field: ['id'], aggregation: 'count' }] } }));
  assert.ok(checkRequest(db, 'appointments.payments', 'list', {}));
  assert.ok(checkRequest(db, 'customers.payments', 'list', {}));
  assert.equal(checkRequest(db, 'appointments.appointmentServices', 'list', {}), null);
});

test('filters, sorts, aggregates and export columns on financial fields are refused', () => {
  assert.ok(checkRequest(db, 'appointmentServices', 'list', { filter: { priceAtBooking: { $gt: 50 } } }));
  assert.ok(checkRequest(db, 'appointments', 'list', { filter: { $and: [{ status: 'completed' }, { 'appointmentServices.priceAtBooking': { $gte: 10 } }] } }));
  assert.ok(checkRequest(db, 'appointments', 'list', { filter: { appointmentServices: { priceAtBooking: { $gte: 10 } } } }));
  assert.ok(checkRequest(db, 'customers', 'list', { filter: { payments: { amount: { $gt: 0 } } } }));
  assert.ok(checkRequest(db, 'customers', 'list', { sort: ['-totalSpent'] }));
  assert.ok(checkRequest(db, 'customers', 'list', { sort: 'firstName,-totalSpent' }));
  assert.ok(checkRequest(db, 'appointmentServices', 'query', { values: { measures: [{ field: ['priceAtBooking'], aggregation: 'sum' }] } }));
  assert.ok(checkRequest(db, 'appointments', 'query', { values: { dimensions: [{ field: ['payments', 'amount'] }] } }));
  assert.ok(checkRequest(db, 'appointments', 'query', { values: { orders: [{ field: ['appointmentServices', 'priceAtBooking'] }] } }));
  assert.ok(checkRequest(db, 'services', 'export', { values: { columns: [{ dataIndex: ['price'] }] } }));
  assert.ok(checkRequest(db, 'customers', 'list', { filter: { activity: { spentLast12m: { $gt: 100 } } } }));
});

test('nonfinancial requests pass unchanged', () => {
  const params = { filter: { $and: [{ staffId: 1 }, { status: 'completed' }] }, sort: ['-startTime'], fields: ['id', 'status'], appends: ['customer'] };
  assert.equal(checkRequest(db, 'appointments', 'list', params), null);
  assert.deepEqual(params.fields, ['id', 'status']);
  assert.deepEqual(params.appends, ['customer']);
  assert.equal(checkRequest(db, 'appointments', 'query', { values: { measures: [{ field: ['id'], aggregation: 'count' }], dimensions: [{ field: ['staffId'] }, { field: ['status'] }] } }), null);
  assert.equal(checkRequest(db, 'appointmentServices', 'query', { values: { measures: [{ field: ['id'], aggregation: 'count' }], dimensions: [{ field: ['appointment', 'staffId'] }, { field: ['serviceId'] }] } }), null);
  assert.equal(checkRequest(db, 'staffWorkspace', 'get', {}), null); // custom endpoints are not collection resources
});

test('financial fields and appends are dropped from read selections', () => {
  const params: any = { fields: ['id', 'priceAtBooking', 'service.price', 'service.name'], appends: ['service', 'appointment.payments'], except: ['priceAtBooking'] };
  assert.equal(checkRequest(db, 'appointmentServices', 'list', params), null);
  assert.deepEqual(params.fields, ['id', 'service.name']);
  assert.deepEqual(params.appends, ['service']);
  assert.deepEqual(params.except, []);
});

test('financial values are dropped from writes', () => {
  const values: any = { status: 'scheduled', payments: [{ amount: 10 }], appointmentServices: [{ serviceId: 1, priceAtBooking: 0 }] };
  dropFinancialValues(db, 'appointments', values);
  assert.deepEqual(values, { status: 'scheduled', appointmentServices: [{ serviceId: 1 }] });
  const params: any = { values: { note: 'x', priceAtBooking: 1 } };
  assert.equal(checkRequest(db, 'appointmentServices', 'update', params), null);
  assert.deepEqual(params.values, { note: 'x' });
});

test('responses lose financial fields at any depth', () => {
  const body = {
    rows: [
      {
        id: 1,
        status: 'completed',
        payments: [{ id: 9, amount: 120 }],
        customer: { id: 2, firstName: 'A', totalSpent: 900, activity: { id: 2, totalVisits: 4, spentLast12m: 300 } },
        appointmentServices: [{ id: 3, priceAtBooking: 60, service: { id: 4, name: 'Facial', price: 60 } }],
      },
    ],
    count: 1,
  };
  const out = stripFinancial(db, 'appointments', body);
  assert.deepEqual(out, {
    rows: [{ id: 1, status: 'completed', customer: { id: 2, firstName: 'A', activity: { id: 2, totalVisits: 4 } }, appointmentServices: [{ id: 3, service: { id: 4, name: 'Facial' } }] }],
    count: 1,
  });
  assert.equal(JSON.stringify(out).match(/amount|price|totalSpent|spent/i), null);
  assert.deepEqual(stripFinancial(db, 'payments', [{ id: 1, amount: 5 }]), []);
  assert.deepEqual(stripFinancial(db, 'services', { id: 4, name: 'Facial', price: 60, toJSON() { return { id: 4, name: 'Facial', price: 60 }; } }), { id: 4, name: 'Facial' });
});

test('middleware: refuses, strips, and leaves Admin/Manager/Receptionist untouched', async () => {
  const app = { db };
  const guard = financialGuard(app);
  const ctxFor = (role: string, resourceName: string, actionName: string, params: any, result: any) => ({
    state: { currentRole: role },
    action: { resourceName, actionName, params },
    body: undefined as any,
    throw: (status: number, message: string) => { const e: any = new Error(message); e.status = status; throw e; },
    run: async function () { await guard(this, async () => { this.body = JSON.parse(JSON.stringify(result)); }); return this; },
  });
  const svc = [{ id: 4, name: 'Facial', price: 60 }];
  assert.deepEqual((await ctxFor('staff', 'services', 'list', {}, svc).run()).body, [{ id: 4, name: 'Facial' }]);
  for (const role of ['admin', 'manager', 'receptionist']) assert.deepEqual((await ctxFor(role, 'services', 'list', {}, svc).run()).body, svc, role);
  await assert.rejects(ctxFor('staff', 'payments', 'list', {}, []).run(), (e: any) => e.status === 403);
  await assert.rejects(ctxFor('staff', 'appointmentServices', 'query', { values: { measures: [{ field: ['priceAtBooking'], aggregation: 'sum' }] } }, []).run(), (e: any) => e.status === 403);
  await assert.doesNotReject(ctxFor('manager', 'payments', 'query', { values: { measures: [{ field: ['amount'], aggregation: 'sum' }] } }, []).run());
});

test('config covers the payments table and every money column found in the schema audit', () => {
  assert.deepEqual(FINANCIAL.collections, ['payments']);
  assert.deepEqual(FINANCIAL.fields.appointmentServices, ['priceAtBooking']);
  assert.ok(FINANCIAL.fields.customerActivity.includes('spentLast12m'));
});
