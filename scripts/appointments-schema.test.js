const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  APPOINTMENT_CATEGORIES,
  APPOINTMENT_STATUSES,
  CATEGORY_TABS,
  DEFAULT_CATEGORY,
  DEFAULT_STATUS,
  getCategoryFilter,
  validateAppointment,
} = require('./appointments-schema');

const migration = fs.readFileSync(
  path.join(__dirname, 'migrations', '20261002_configure_appointments_collection.sql'),
  'utf8',
);

test('category and status enums match the SQL migration', () => {
  const categoryValues = APPOINTMENT_CATEGORIES.map((item) => `'${item.value}'`).join(', ');
  assert.ok(migration.includes(`CHECK ("category" IN (${categoryValues}))`));
  const statusValues = APPOINTMENT_STATUSES.map((item) => `'${item.value}'`).join(', ');
  assert.ok(migration.includes(`CHECK ("status" IN (${statusValues}))`));
  assert.ok(migration.includes(`SET DEFAULT '${DEFAULT_CATEGORY}'`));
  assert.ok(migration.includes(`SET DEFAULT '${DEFAULT_STATUS}'`));
  for (const item of APPOINTMENT_CATEGORIES) {
    assert.ok(migration.includes(`{"value":"${item.value}","label":"${item.label}","color":"${item.color}"}`));
  }
});

test('filter tabs cover All / Sessions / Events', () => {
  assert.deepEqual(
    CATEGORY_TABS.map((tab) => tab.label),
    ['All', 'Sessions', 'Events'],
  );
  assert.deepEqual(getCategoryFilter('all'), {});
  assert.deepEqual(getCategoryFilter('sessions'), { category: { $eq: 'session' } });
  assert.deepEqual(getCategoryFilter('events'), { category: { $eq: 'event' } });
  assert.throws(() => getCategoryFilter('unknown'), /Unknown appointment tab/);
});

test('a minimal valid appointment defaults to a scheduled session', () => {
  const result = validateAppointment({
    customerId: '1',
    appointmentDate: '2026-10-10',
    startTime: '2026-10-10T10:00:00Z',
  });
  assert.equal(result.valid, true);
  assert.equal(result.record.category, 'session');
  assert.equal(result.record.status, 'scheduled');
});

test('required fields are enforced', () => {
  const result = validateAppointment({});
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes('customerId is required'));
  assert.ok(result.errors.includes('appointmentDate is required'));
  assert.ok(result.errors.includes('startTime is required'));
});

test('enum values are enforced', () => {
  const result = validateAppointment({
    customerId: '1',
    appointmentDate: '2026-10-10',
    startTime: '2026-10-10T10:00:00Z',
    category: 'party',
    status: 'done',
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.startsWith('category must be one of')));
  assert.ok(result.errors.some((error) => error.startsWith('status must be one of')));
});

test('endTime must be after startTime when provided', () => {
  const base = { customerId: '1', appointmentDate: '2026-10-10', startTime: '2026-10-10T10:00:00Z' };
  assert.equal(validateAppointment({ ...base, endTime: '2026-10-10T11:00:00Z' }).valid, true);
  assert.equal(validateAppointment({ ...base, endTime: null }).valid, true);
  const equal = validateAppointment({ ...base, endTime: '2026-10-10T10:00:00Z' });
  assert.equal(equal.valid, false);
  assert.ok(equal.errors.includes('endTime must be after startTime'));
  const invalid = validateAppointment({ ...base, endTime: 'not-a-date' });
  assert.ok(invalid.errors.includes('endTime must be a valid date-time'));
});
