// Seeds test customers for the customer activity filters, one per situation the filters distinguish.
//
// Usage: yarn seed:customer-activity            # (re)create the seed customers, their appointments and payments
//        yarn seed:customer-activity --remove   # delete everything this script created
//
// Goes through the NocoBase REST API of the running app (same credentials and target rules as the other apply
// scripts: .env, NOCOBASE_API_URL), so the database triggers refresh the activity columns as the rows arrive.
// Every seed customer is named "QA Activity <situation>" with an @example.test email and a note saying it is seed
// data, so they are easy to spot and `--remove` finds them by email. Re-running removes and recreates them.
//
// Dates are relative to today, so the same seed stays meaningful whenever it is run.

const { createClient, formatErrors } = require('./nocobase-api');

const EMAIL_DOMAIN = 'example.test';
const emailFor = (key) => `qa.activity.${key.toLowerCase()}@${EMAIL_DOMAIN}`;
const NOTE = 'Seed data for the customer activity filters (yarn seed:customer-activity). Safe to delete.';

// days: how many days ago the appointment started. status defaults to completed. amount: a paid service payment.
const visit = (days, extra = {}) => ({ days, status: 'completed', amount: 60, ...extra });

// Expectations are documented against the 3-month default period (relative to the day the seed runs).
const PERSONAS = [
  { key: 'RegularRecent', lastName: 'Regular recent', phone: '312-555-9001', visits: [visit(10), visit(40), visit(70), visit(100)],
    expect: 'most active (3m), repeat, high-value; sorts first under "most active first"' },
  { key: 'AtRisk', lastName: 'At risk', phone: '312-555-9002', visits: [visit(150), visit(180), visit(210), visit(240)],
    expect: 'at risk (regular, away 5 months), inactive 3+ and 4+, repeat' },
  { key: 'InactiveYear', lastName: 'Inactive a year', phone: '312-555-9003', visits: [visit(400), visit(430)],
    expect: 'inactive 12+, most inactive; not at risk (outside the 12-month window)' },
  { key: 'OneTime', lastName: 'One time', phone: '312-555-9004', visits: [visit(20)],
    expect: 'one-time, new in the last month' },
  { key: 'NewRepeat', lastName: 'New repeat', phone: '312-555-9005', visits: [visit(45), visit(15)],
    expect: 'new in the last 2 months, repeat, most active (3m)' },
  { key: 'NeverVisited', lastName: 'Never visited', phone: '312-555-9006', visits: [visit(-7, { status: 'scheduled', amount: 0 })],
    expect: 'never visited (only a future scheduled appointment)' },
  { key: 'CancelledOnly', lastName: 'Cancelled only', phone: '312-555-9007', visits: [visit(30, { status: 'cancelled', amount: 0 }), visit(12, { status: 'noShow', amount: 0 })],
    expect: 'never visited (cancelled and no-show do not count)' },
  { key: 'Band3to4', lastName: 'Band three to four', phone: '312-555-9008', visits: [visit(105), visit(200)],
    expect: 'last visited 3-4 months ago, inactive 3+, repeat' },
  { key: 'BigSpender', lastName: 'Big spender', phone: '312-555-9009', visits: [visit(60, { amount: 300 }), visit(90, { amount: 250 })],
    payments: [{ days: 60, amount: -50, type: 'refund', status: 'refunded' }, { days: 5, amount: 100, type: 'deposit', status: 'pending' }],
    expect: 'high-value top (net 500: refunds deducted, pending ignored), most active (3m)' },
  { key: 'LapsedRegular', lastName: 'Lapsed regular', phone: '312-555-9010', visits: [visit(220), visit(250), visit(280)],
    expect: 'at risk for periods up to 6 months (away 7 months), inactive 6+' },
];

const daysAgo = (days, hour = 10) => {
  const d = new Date();
  d.setUTCHours(hour, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - days);
  return d;
};
const plusMinutes = (date, minutes) => new Date(date.getTime() + minutes * 60000);

async function listSeedCustomers(client) {
  const filter = encodeURIComponent(JSON.stringify({ email: { $endsWith: `@${EMAIL_DOMAIN}` }, firstName: 'QA Activity' }));
  const result = await client.request(`customers:list?paginate=false&filter=${filter}&fields=id,firstName,lastName,email`);
  if (!result.ok) throw new Error(`customers:list failed (${result.status}): ${formatErrors(result.json)}`);
  return result.json.data || [];
}

async function destroyWhere(client, collection, filter) {
  const result = await client.request(`${collection}:destroy?filter=${encodeURIComponent(JSON.stringify(filter))}`, { method: 'POST' });
  if (!result.ok) throw new Error(`${collection}:destroy failed (${result.status}): ${formatErrors(result.json)}`);
}

async function remove(client) {
  const customers = await listSeedCustomers(client);
  if (!customers.length) return 0;
  const ids = customers.map((c) => c.id);
  await destroyWhere(client, 'payments', { customerId: { $in: ids } });
  await destroyWhere(client, 'appointmentServices', { 'appointment.customerId': { $in: ids } });
  await destroyWhere(client, 'appointments', { customerId: { $in: ids } });
  await destroyWhere(client, 'customers', { id: { $in: ids } });
  return ids.length;
}

async function create(client, collection, values) {
  const result = await client.request(`${collection}:create`, { method: 'POST', body: values });
  if (!result.ok) throw new Error(`${collection}:create failed (${result.status}): ${formatErrors(result.json)}\n${JSON.stringify(values)}`);
  return result.json.data;
}

async function seed(client) {
  const created = [];
  for (const persona of PERSONAS) {
    const customer = await create(client, 'customers', {
      firstName: 'QA Activity', lastName: persona.lastName, email: emailFor(persona.key), phone: persona.phone, status: 'active', notes: NOTE,
    });
    let appointments = 0; let payments = 0;
    for (const v of persona.visits) {
      const start = daysAgo(v.days);
      const appointment = await create(client, 'appointments', {
        customer: { id: customer.id }, category: 'session', status: v.status, startTime: start.toISOString(), endTime: plusMinutes(start, 60).toISOString(), notes: NOTE,
      });
      appointments += 1;
      if (v.status === 'completed' && v.amount > 0) {
        await create(client, 'payments', {
          customer: { id: customer.id }, appointment: { id: appointment.id }, amount: v.amount, paymentType: 'service', paymentMethod: 'card', paymentDate: plusMinutes(start, 60).toISOString(), status: 'paid', notes: NOTE,
        });
        payments += 1;
      }
    }
    for (const p of persona.payments || []) {
      await create(client, 'payments', {
        customer: { id: customer.id }, amount: p.amount, paymentType: p.type, paymentMethod: 'card', paymentDate: daysAgo(p.days, 12).toISOString(), status: p.status, notes: NOTE,
      });
      payments += 1;
    }
    created.push({ customer: `${customer.firstName} ${customer.lastName}`, id: customer.id, appointments, payments, expect: persona.expect });
  }
  return created;
}

// Reads the seeded customers back with their activity columns, so the result of the triggers is visible at once.
async function report(client) {
  const filter = encodeURIComponent(JSON.stringify({ email: { $endsWith: `@${EMAIL_DOMAIN}` }, firstName: 'QA Activity' }));
  const result = await client.request(`customers:list?paginate=false&filter=${filter}&sort=lastName&fields=lastName,visitCount,firstVisitAt,lastVisitAt,visitsLast1m,visitsLast3m,visitsLast6m,visitsLast12m,totalSpent`);
  if (!result.ok) throw new Error(`customers:list failed (${result.status}): ${formatErrors(result.json)}`);
  return (result.json.data || []).map((c) => ({
    customer: c.lastName,
    visits: c.visitCount,
    first: c.firstVisitAt ? c.firstVisitAt.slice(0, 10) : null,
    last: c.lastVisitAt ? c.lastVisitAt.slice(0, 10) : null,
    v1m: c.visitsLast1m, v3m: c.visitsLast3m, v6m: c.visitsLast6m, v12m: c.visitsLast12m,
    spent: c.totalSpent,
  }));
}

async function main() {
  const client = await createClient();
  if (process.argv.includes('--remove')) {
    const removed = await remove(client);
    console.log(JSON.stringify({ status: 'ok', target: client.baseUrl, removed }, null, 2));
    return;
  }
  const removed = await remove(client);
  const created = await seed(client);
  const activity = await report(client);
  console.log(JSON.stringify({ status: 'ok', target: client.baseUrl, replaced: removed, created }, null, 2));
  console.log('\nActivity columns as refreshed by the triggers:');
  console.table(activity);
  console.log('Remove again with: yarn seed:customer-activity --remove');
}

main().catch((error) => {
  console.error(`Customer activity seed failed: ${error.message}`);
  process.exitCode = 1;
});
