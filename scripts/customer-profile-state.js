const NOT_PROVIDED = 'Not provided';
const NO_SENSITIVITIES = 'No sensitivities recorded';
const NO_SERVICE_HISTORY = 'No service history recorded';

function isBlank(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

function safeText(value, fallback = NOT_PROVIDED) {
  if (isBlank(value)) return fallback;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') {
    const label = value.label ?? value.name ?? value.title;
    if (typeof label === 'string' && label.trim()) return label.trim();
  }
  return fallback;
}

function safeList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => safeText(item, '')).filter(Boolean);
}

function unwrapApiRecord(payload) {
  let value = payload;
  for (let depth = 0; depth < 2; depth += 1) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !value.data || typeof value.data !== 'object' || Array.isArray(value.data)) break;
    value = value.data;
  }
  return value;
}

function normalizeCustomer(payload) {
  const record = unwrapApiRecord(payload);
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const firstName = safeText(record.firstName, '');
  const lastName = safeText(record.lastName, '');
  const fullName = safeText(record.fullName, '') || safeText(record.name, '') || [firstName, lastName].filter(Boolean).join(' ') || NOT_PROVIDED;
  return {
    id: safeText(record.id, ''),
    fullName,
    phone: safeText(record.phone),
    email: safeText(record.email),
    skinProfile: safeText(record.skinProfile),
    skinProfileOther: safeText(record.skinProfileOther),
    skinSensitivities: safeList(record.skinSensitivities),
    skinSensitivitiesOther: safeText(record.skinSensitivitiesOther),
    preferences: safeText(record.preferences),
    notes: safeText(record.notes),
  };
}

function normalizeServiceHistory(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const record = item && typeof item === 'object' ? item : {};
    return {
      service: safeText(record.service),
      date: safeText(record.date ?? record.appointmentDate),
      provider: safeText(record.provider ?? record.staff),
      status: safeText(record.status),
      notes: safeText(record.notes),
    };
  });
}

function getIncompleteFields(customer) {
  if (!customer) return [];
  const incomplete = [];
  if (customer.phone === NOT_PROVIDED) incomplete.push('phone');
  if (customer.email === NOT_PROVIDED) incomplete.push('email');
  if (customer.skinProfile === NOT_PROVIDED) incomplete.push('skinProfile');
  if (!customer.skinSensitivities.length) incomplete.push('skinSensitivities');
  if (customer.preferences === NOT_PROVIDED) incomplete.push('preferences');
  if (customer.notes === NOT_PROVIDED) incomplete.push('notes');
  return incomplete;
}

function getProfileFieldStates(customer) {
  if (!customer) return {};
  const fieldStates = {};
  const add = (field, value, message) => {
    fieldStates[field] = { status: value ? 'complete' : 'incomplete', message: value ? null : message };
  };
  add('phone', customer.phone !== NOT_PROVIDED, 'Phone not provided');
  add('email', customer.email !== NOT_PROVIDED, 'Email not provided');
  add('skinProfile', customer.skinProfile !== NOT_PROVIDED, 'Skin profile not provided');
  add('preferences', customer.preferences !== NOT_PROVIDED, 'Preferences not provided');
  add('notes', customer.notes !== NOT_PROVIDED, 'Notes not provided');
  fieldStates.skinSensitivities = customer.skinSensitivities.length
    ? { status: 'complete', message: null }
    : { status: 'incomplete', message: NO_SENSITIVITIES };
  return fieldStates;
}

function getProfileState({ customer, serviceHistory, loading = false, customerError = null, serviceHistoryError = null } = {}) {
  if (loading) return { status: 'loading', customer: null, serviceHistory: [], incompleteFields: [], fieldStates: {}, error: null, canRetry: false, backToCustomers: false };
  if (customerError) {
    const notFound = customerError.code === 'NOT_FOUND';
    return {
      status: notFound ? 'not-found' : 'error',
      customer: null,
      serviceHistory: [],
      incompleteFields: [],
      fieldStates: {},
      error: notFound ? 'Customer not found.' : 'Unable to load this customer profile. Please retry.',
      canRetry: !notFound,
      backToCustomers: true,
    };
  }
  const normalizedCustomer = normalizeCustomer(customer);
  if (!normalizedCustomer?.id) return { status: 'not-found', customer: null, serviceHistory: [], incompleteFields: [], fieldStates: {}, error: 'Customer not found.', canRetry: false, backToCustomers: true };
  const historyMalformed = serviceHistory !== undefined && !Array.isArray(serviceHistory);
  const historyError = serviceHistoryError || (historyMalformed ? { code: 'MALFORMED_RESPONSE' } : null);
  return {
    status: 'ready',
    customer: normalizedCustomer,
    serviceHistory: historyError ? [] : normalizeServiceHistory(serviceHistory),
    incompleteFields: getIncompleteFields(normalizedCustomer),
    fieldStates: getProfileFieldStates(normalizedCustomer),
    serviceHistoryError: historyError ? 'Service history could not be loaded. Please retry.' : null,
    serviceHistoryEmptyText: historyError ? null : NO_SERVICE_HISTORY,
    serviceHistoryCanRetry: Boolean(historyError),
    sensitivitiesEmptyText: normalizedCustomer.skinSensitivities.length ? null : NO_SENSITIVITIES,
    canRetry: false,
    backToCustomers: true,
  };
}

module.exports = {
  NOT_PROVIDED,
  NO_SENSITIVITIES,
  NO_SERVICE_HISTORY,
  getIncompleteFields,
  getProfileFieldStates,
  getProfileState,
  normalizeCustomer,
  normalizeServiceHistory,
  unwrapApiRecord,
  safeText,
};
