const NOT_PROVIDED = 'Not provided';
const NO_SENSITIVITIES = 'No sensitivities recorded';

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

function normalizeCustomer(payload) {
  const record = payload?.data ?? payload;
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

function getProfileState({ customer, serviceHistory, loading = false, customerError = null, serviceHistoryError = null } = {}) {
  if (loading) return { status: 'loading', customer: null, serviceHistory: [], incompleteFields: [], error: null };
  if (customerError) return { status: customerError.code === 'NOT_FOUND' ? 'not-found' : 'error', customer: null, serviceHistory: [], incompleteFields: [], error: 'Unable to load this customer profile. Please retry.' };
  const normalizedCustomer = normalizeCustomer(customer);
  if (!normalizedCustomer?.id) return { status: 'not-found', customer: null, serviceHistory: [], incompleteFields: [], error: null };
  return {
    status: 'ready',
    customer: normalizedCustomer,
    serviceHistory: normalizeServiceHistory(serviceHistory),
    incompleteFields: getIncompleteFields(normalizedCustomer),
    serviceHistoryError: serviceHistoryError ? 'Service history could not be loaded. Please retry.' : null,
    sensitivitiesEmptyText: normalizedCustomer.skinSensitivities.length ? null : NO_SENSITIVITIES,
  };
}

module.exports = {
  NOT_PROVIDED,
  NO_SENSITIVITIES,
  getIncompleteFields,
  getProfileState,
  normalizeCustomer,
  normalizeServiceHistory,
  safeText,
};
