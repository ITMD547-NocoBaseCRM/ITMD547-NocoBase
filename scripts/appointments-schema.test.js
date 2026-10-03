const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  APPOINTMENT_CATEGORIES,
  APPOINTMENT_STATUSES,
  CATEGORY_TABS,
  DEFAULT_CATEGORY,
  DEFAULT_SALON_TIMEZONE,
  DEFAULT_STATUS,
  DERIVED_FIELDS,
  deriveAppointmentDate,
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
  assert.ok(!result.errors.some((error) => error.startsWith('appointmentDate')), 'the date is derived, never required');
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

test('the appointment date is derived from the start time in the salon time zone', () => {
  assert.equal(deriveAppointmentDate('2027-03-18T15:00:00Z'), '2027-03-18');
  // 9 pm in Chicago (CDT, UTC-5) is already the next day in UTC: the salon's calendar date wins
  assert.equal(deriveAppointmentDate('2027-03-19T02:00:00Z'), '2027-03-18');
  // 1 am in Chicago (CST, UTC-6, before daylight saving) is still the previous UTC day
  assert.equal(deriveAppointmentDate('2027-02-10T07:00:00Z'), '2027-02-10');
  assert.equal(deriveAppointmentDate('2027-02-10T05:30:00Z'), '2027-02-09');
  // other zones can be given explicitly
  assert.equal(deriveAppointmentDate('2027-03-19T02:00:00Z', 'UTC'), '2027-03-19');
  assert.equal(deriveAppointmentDate(new Date('2027-03-18T15:00:00Z')), '2027-03-18');
  for (const missing of [undefined, null, '', 'not-a-date', 'later']) {
    assert.equal(deriveAppointmentDate(missing), null, String(missing));
  }
});

test('an appointment keeps the date it started on, and a supplied date never overrides the start time', () => {
  const overnight = validateAppointment({
    customerId: '1',
    startTime: '2027-03-18T23:30:00-05:00',
    endTime: '2027-03-19T00:30:00-05:00',
  });
  assert.equal(overnight.valid, true);
  assert.equal(overnight.record.appointmentDate, '2027-03-18', 'runs past midnight but keeps its start date');

  const wrongDate = validateAppointment({
    customerId: '1',
    appointmentDate: '2020-01-01',
    startTime: '2027-03-18T10:00:00Z',
  });
  assert.equal(wrongDate.record.appointmentDate, '2027-03-18');
});

test('the database trigger uses the same default time zone and derivation as the schema module', () => {
  assert.equal(DEFAULT_SALON_TIMEZONE, 'America/Chicago');
  assert.deepEqual(DERIVED_FIELDS, ['appointmentDate']);
  const trigger = fs.readFileSync(path.join(__dirname, 'migrations', '20261003_derive_appointment_date.sql'), 'utf8');
  assert.ok(trigger.includes("'" + DEFAULT_SALON_TIMEZONE + "'"), 'the trigger default zone must match');
  assert.ok(trigger.includes('crm.salon_timezone'), 'the zone is configurable per database');
  assert.ok(trigger.includes('NEW."appointmentDate" := (NEW."startTime" AT TIME ZONE salon_timezone)::date'));
  assert.ok(trigger.includes('BEFORE INSERT OR UPDATE OF "startTime", "appointmentDate"'));
});
