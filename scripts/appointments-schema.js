// Shared contract for the appointments collection (US-26 / T-40).
// The values here must stay in sync with scripts/migrations/20261002_configure_appointments_collection.sql;
// validate-appointments-collection.js cross-checks the database against this module.

const APPOINTMENT_CATEGORIES = [
  { value: 'session', label: 'Session', color: 'blue' },
  { value: 'event', label: 'Event', color: 'purple' },
];

const APPOINTMENT_STATUSES = [
  { value: 'scheduled', label: 'Scheduled', color: 'blue' },
  { value: 'confirmed', label: 'Confirmed', color: 'cyan' },
  { value: 'inProgress', label: 'In progress', color: 'gold' },
  { value: 'completed', label: 'Completed', color: 'green' },
  { value: 'cancelled', label: 'Cancelled', color: 'red' },
  { value: 'noShow', label: 'No show', color: 'volcano' },
];

const DEFAULT_CATEGORY = 'session';
const DEFAULT_STATUS = 'scheduled';

// Filter tabs required by US-26. "all" applies no category filter.
const CATEGORY_TABS = [
  { key: 'all', label: 'All', category: null },
  { key: 'sessions', label: 'Sessions', category: 'session' },
  { key: 'events', label: 'Events', category: 'event' },
];

const REQUIRED_FIELDS = ['customerId', 'appointmentDate', 'startTime', 'status', 'category'];

function isAppointmentCategory(value) {
  return APPOINTMENT_CATEGORIES.some((item) => item.value === value);
}

function isAppointmentStatus(value) {
  return APPOINTMENT_STATUSES.some((item) => item.value === value);
}

function getCategoryFilter(tabKey) {
  const tab = CATEGORY_TABS.find((item) => item.key === tabKey);
  if (!tab) throw new Error(`Unknown appointment tab: ${tabKey}`);
  return tab.category ? { category: { $eq: tab.category } } : {};
}

function isBlank(value) {
  return value === undefined || value === null || value === '';
}

function toTime(value) {
  if (isBlank(value)) return null;
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

// Mirrors the database rules: required columns, enum checks and endTime > startTime.
function validateAppointment(input = {}) {
  const errors = [];
  const record = { category: DEFAULT_CATEGORY, status: DEFAULT_STATUS, ...input };
  for (const field of REQUIRED_FIELDS) {
    if (isBlank(record[field])) errors.push(`${field} is required`);
  }
  if (!isBlank(record.category) && !isAppointmentCategory(record.category)) {
    errors.push(`category must be one of: ${APPOINTMENT_CATEGORIES.map((item) => item.value).join(', ')}`);
  }
  if (!isBlank(record.status) && !isAppointmentStatus(record.status)) {
    errors.push(`status must be one of: ${APPOINTMENT_STATUSES.map((item) => item.value).join(', ')}`);
  }
  const start = toTime(record.startTime);
  const end = toTime(record.endTime);
  if (start !== null && Number.isNaN(start)) errors.push('startTime must be a valid date-time');
  if (end !== null && Number.isNaN(end)) errors.push('endTime must be a valid date-time');
  if (start !== null && end !== null && !Number.isNaN(start) && !Number.isNaN(end) && end <= start) {
    errors.push('endTime must be after startTime');
  }
  return { valid: errors.length === 0, errors, record };
}

module.exports = {
  APPOINTMENT_CATEGORIES,
  APPOINTMENT_STATUSES,
  CATEGORY_TABS,
  DEFAULT_CATEGORY,
  DEFAULT_STATUS,
  REQUIRED_FIELDS,
  getCategoryFilter,
  isAppointmentCategory,
  isAppointmentStatus,
  validateAppointment,
};
