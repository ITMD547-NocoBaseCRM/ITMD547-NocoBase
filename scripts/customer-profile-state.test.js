const test = require('node:test');
const assert = require('node:assert/strict');
const {
  NO_SENSITIVITIES,
  NOT_PROVIDED,
  getProfileState,
  normalizeCustomer,
  normalizeServiceHistory,
  safeText,
} = require('./customer-profile-state');

const completeCustomer = {
  id: 'customer-1', firstName: 'Ava', lastName: 'Stone', phone: '555-0100', email: 'ava@example.test',
  skinProfile: 'normal', skinSensitivities: ['fragrancesPerfumes'], preferences: 'Morning visits', notes: 'Prefers a quiet appointment.',
};

test('normalizes a complete customer profile', () => {
  const state = getProfileState({ customer: completeCustomer, serviceHistory: [{ service: 'Facial', date: '2026-09-01', provider: 'Mia', status: 'completed', notes: 'Good result' }] });
  assert.equal(state.status, 'ready');
  assert.equal(state.customer.fullName, 'Ava Stone');
  assert.deepEqual(state.incompleteFields, []);
  assert.equal(state.serviceHistory[0].service, 'Facial');
});

test('keeps minimal profiles usable and marks optional gaps', () => {
  const state = getProfileState({ customer: { id: 'minimal', name: 'Minimal Customer' }, serviceHistory: [] });
  assert.equal(state.status, 'ready');
  assert.equal(state.customer.phone, NOT_PROVIDED);
  assert.ok(state.incompleteFields.includes('email'));
  assert.equal(state.sensitivitiesEmptyText, NO_SENSITIVITIES);
});

for (const skinProfile of ['normal', 'dry', 'oily', 'combination', 'sensitive', 'other']) {
  test(`supports skin profile ${skinProfile}`, () => {
    const customer = normalizeCustomer({ ...completeCustomer, skinProfile });
    assert.equal(customer.skinProfile, skinProfile);
  });
}

test('distinguishes no sensitivities, one sensitivity, many sensitivities, and Other', () => {
  assert.deepEqual(normalizeCustomer({ ...completeCustomer, skinSensitivities: [] }).skinSensitivities, []);
  assert.deepEqual(normalizeCustomer({ ...completeCustomer, skinSensitivities: ['latex'] }).skinSensitivities, ['latex']);
  assert.equal(normalizeCustomer({ ...completeCustomer, skinSensitivities: ['latex', 'other'], skinSensitivitiesOther: 'A custom sensitivity' }).skinSensitivitiesOther, 'A custom sensitivity');
  assert.equal(getProfileState({ customer: { ...completeCustomer, skinSensitivities: [] } }).sensitivitiesEmptyText, NO_SENSITIVITIES);
});

test('preserves long notes as text without rendering object values', () => {
  const notes = 'Long note '.repeat(100);
  const customer = normalizeCustomer({ ...completeCustomer, notes });
  assert.equal(customer.notes, notes);
  assert.equal(safeText({ unexpected: true }), NOT_PROVIDED);
  assert.equal(safeText(null), NOT_PROVIDED);
});

test('normalizes large service histories and missing service fields', () => {
  const history = normalizeServiceHistory(Array.from({ length: 100 }, (_, index) => ({ service: `Service ${index}` })));
  assert.equal(history.length, 100);
  assert.equal(history[0].date, NOT_PROVIDED);
  assert.equal(history[99].service, 'Service 99');
});

test('returns clean loading, not-found, API error, and service-history error states', () => {
  assert.equal(getProfileState({ loading: true }).status, 'loading');
  assert.equal(getProfileState({ customerError: { code: 'NOT_FOUND' } }).status, 'not-found');
  assert.equal(getProfileState({ customerError: new Error('database details') }).error, 'Unable to load this customer profile. Please retry.');
  assert.equal(getProfileState({ customer: completeCustomer, serviceHistoryError: new Error('secret') }).serviceHistoryError, 'Service history could not be loaded. Please retry.');
});
