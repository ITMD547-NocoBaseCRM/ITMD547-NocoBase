const test = require('node:test');
const assert = require('node:assert/strict');
const { OUTCOMES, createLookups, stageImport, normalisePhone } = require('./appointments-import');

const lookups = createLookups({
  customers: [
    { id: 'c1', externalId: 'CUST-1', email: 'ava@example.test', phone: '(555) 010-0001' },
    { id: 'c2', email: 'shared@example.test', phone: '555-0002' },
    { id: 'c3', email: 'SHARED@example.test', phone: '555-0003' },
  ],
  staff: [{ id: 's1', externalId: 'EMP-9', email: 'mia@example.test' }],
  services: [{ id: 'v1', externalId: 'SVC-1', name: 'Classic Facial' }],
  existingAppointments: [{ externalSource: 'legacy', externalId: 'A-100' }],
});

const base = {
  externalSource: 'legacy',
  externalId: 'A-1',
  customerExternalId: 'CUST-1',
  technicianExternalId: 'EMP-9',
  serviceExternalIds: ['SVC-1'],
  appointmentDate: '2026-10-10',
  startTime: '2026-10-10T10:00:00Z',
  endTime: '2026-10-10T11:00:00Z',
  status: 'completed',
  category: 'session',
  notes: 'ok',
};

test('a fully resolved record is ready with NocoBase ids', () => {
  const { summary, ready } = stageImport([base], lookups);
  assert.equal(summary.ready, 1);
  assert.deepEqual(ready[0], {
    externalSource: 'legacy',
    externalId: 'A-1',
    customerId: 'c1',
    staffId: 's1',
    serviceIds: ['v1'],
    category: 'session',
    status: 'completed',
    appointmentDate: '2026-10-10',
    startTime: '2026-10-10T10:00:00Z',
    endTime: '2026-10-10T11:00:00Z',
    notes: 'ok',
  });
});

test('reruns skip already imported identities and batches reject repeats', () => {
  const { summary, report } = stageImport([{ ...base, externalId: 'A-100' }, base, base], lookups);
  assert.equal(summary.existing, 1);
  assert.equal(summary.duplicate, 1);
  assert.equal(summary.ready, 1);
  assert.deepEqual(
    report.map((row) => row.outcome),
    [OUTCOMES.existing, OUTCOMES.duplicate],
  );
});

test('missing customer, technician and service are reported, never guessed', () => {
  const { report } = stageImport(
    [{ ...base, customerExternalId: 'CUST-404', technicianExternalId: 'EMP-404', serviceExternalIds: ['SVC-404'] }],
    lookups,
  );
  assert.equal(report[0].outcome, OUTCOMES.failed);
  assert.deepEqual(report[0].errors, ['customer not found', 'technician not found', 'service not found: SVC-404']);
});

test('customers fall back to email or phone only when unambiguous', () => {
  const byEmail = stageImport([{ ...base, customerExternalId: null, customerEmail: 'AVA@example.test' }], lookups);
  assert.equal(byEmail.summary.ready, 1);
  const byPhone = stageImport([{ ...base, customerExternalId: null, customerPhone: '555 010 0001' }], lookups);
  assert.equal(byPhone.summary.ready, 1);
  const ambiguous = stageImport([{ ...base, customerExternalId: null, customerEmail: 'shared@example.test' }], lookups);
  assert.equal(ambiguous.report[0].errors[0], 'customer not found');
  assert.equal(normalisePhone('+1 (555) 010-0001'), '15550100001');
});

test('unassigned technician is allowed, invalid dates, categories and identities are not', () => {
  const unassigned = stageImport([{ ...base, technicianExternalId: null }], lookups);
  assert.equal(unassigned.ready[0].staffId, null);
  const { report } = stageImport(
    [
      { ...base, startTime: 'yesterday-ish' },
      { ...base, externalId: 'A-2', category: 'party' },
      { ...base, externalId: 'A-3', endTime: '2026-10-10T09:00:00Z' },
      { ...base, externalId: '' },
      'not an object',
    ],
    lookups,
  );
  assert.ok(report[0].errors.includes('startTime must be a valid date-time'));
  assert.ok(report[1].errors.some((error) => error.startsWith('category must be one of')));
  assert.ok(report[2].errors.includes('endTime must be after startTime'));
  assert.ok(report[3].errors.includes('externalId is required'));
  assert.deepEqual(report[4].errors, ['malformed record']);
});
