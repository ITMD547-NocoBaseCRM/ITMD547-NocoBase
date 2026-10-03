// Source-agnostic staging logic for a future appointment import (US-26 / T-41).
//
// It does not read any source system and does not write to the database. A future loader
// maps source rows to the contract shape below, supplies lookups built from NocoBase data,
// and calls stageImport(). The result separates rows that are safe to write from rows that
// must be reported, so reruns and failed-record reporting are handled before any insert.
//
// Contract record (all identifiers are strings from the source system):
//   {
//     externalId, externalSource,
//     customerExternalId | customerEmail | customerPhone,
//     technicianExternalId | technicianEmail,
//     serviceExternalIds: [] | serviceNames: [],
//     category, startTime, endTime, status, notes,   (appointmentDate is derived from startTime)
//   }

const { validateAppointment } = require('./appointments-schema');

const OUTCOMES = Object.freeze({
  ready: 'ready', // valid, resolved, not yet imported
  existing: 'existing', // already imported (same externalSource + externalId), skip on rerun
  duplicate: 'duplicate', // repeated inside the same batch
  failed: 'failed', // malformed or unresolved; reported, never written
});

function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === '';
}

function normaliseEmail(value) {
  return isBlank(value) ? null : String(value).trim().toLowerCase();
}

function normalisePhone(value) {
  if (isBlank(value)) return null;
  const digits = String(value).replace(/\D/g, '');
  return digits || null;
}

// Lookups are plain Maps keyed by stable identifiers. Email/phone are secondary keys used only when
// the source carries no stable customer id. Names are never used for matching.
function createLookups({ customers = [], staff = [], services = [], existingAppointments = [] } = {}) {
  const customerByExternalId = new Map();
  const customerByEmail = new Map();
  const customerByPhone = new Map();
  for (const customer of customers) {
    if (!isBlank(customer.externalId)) customerByExternalId.set(String(customer.externalId), customer.id);
    const email = normaliseEmail(customer.email);
    if (email) customerByEmail.set(email, customerByEmail.has(email) ? 'ambiguous' : customer.id);
    const phone = normalisePhone(customer.phone);
    if (phone) customerByPhone.set(phone, customerByPhone.has(phone) ? 'ambiguous' : customer.id);
  }
  const staffByExternalId = new Map();
  const staffByEmail = new Map();
  for (const member of staff) {
    if (!isBlank(member.externalId)) staffByExternalId.set(String(member.externalId), member.id);
    const email = normaliseEmail(member.email);
    if (email) staffByEmail.set(email, staffByEmail.has(email) ? 'ambiguous' : member.id);
  }
  const serviceByExternalId = new Map();
  const serviceByName = new Map();
  for (const service of services) {
    if (!isBlank(service.externalId)) serviceByExternalId.set(String(service.externalId), service.id);
    if (!isBlank(service.name)) serviceByName.set(String(service.name).trim().toLowerCase(), service.id);
  }
  const existing = new Set(
    existingAppointments
      .filter((row) => !isBlank(row.externalId))
      .map((row) => `${row.externalSource ?? ''}::${row.externalId}`),
  );
  return {
    customerByExternalId,
    customerByEmail,
    customerByPhone,
    staffByExternalId,
    staffByEmail,
    serviceByExternalId,
    serviceByName,
    existing,
  };
}

function resolveCustomer(record, lookups) {
  if (!isBlank(record.customerExternalId)) {
    return lookups.customerByExternalId.get(String(record.customerExternalId)) ?? null;
  }
  const byEmail = lookups.customerByEmail.get(normaliseEmail(record.customerEmail));
  if (byEmail && byEmail !== 'ambiguous') return byEmail;
  const byPhone = lookups.customerByPhone.get(normalisePhone(record.customerPhone));
  if (byPhone && byPhone !== 'ambiguous') return byPhone;
  return null;
}

function resolveTechnician(record, lookups) {
  if (!isBlank(record.technicianExternalId)) {
    return lookups.staffByExternalId.get(String(record.technicianExternalId)) ?? null;
  }
  const byEmail = lookups.staffByEmail.get(normaliseEmail(record.technicianEmail));
  return byEmail && byEmail !== 'ambiguous' ? byEmail : null;
}

function resolveServices(record, lookups) {
  const ids = [];
  const missing = [];
  for (const externalId of record.serviceExternalIds || []) {
    const id = lookups.serviceByExternalId.get(String(externalId));
    if (id) ids.push(id);
    else missing.push(String(externalId));
  }
  for (const name of record.serviceNames || []) {
    const id = lookups.serviceByName.get(String(name).trim().toLowerCase());
    if (id) ids.push(id);
    else missing.push(String(name));
  }
  return { ids, missing };
}

function stageRecord(record, lookups, seenInBatch) {
  const errors = [];
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return { outcome: OUTCOMES.failed, errors: ['malformed record'], record: null };
  }
  if (isBlank(record.externalId)) errors.push('externalId is required');
  if (isBlank(record.externalSource)) errors.push('externalSource is required');

  const identity = `${record.externalSource ?? ''}::${record.externalId ?? ''}`;
  if (errors.length === 0) {
    if (seenInBatch.has(identity)) return { outcome: OUTCOMES.duplicate, errors: ['repeated in batch'], record };
    seenInBatch.add(identity);
    if (lookups.existing.has(identity)) return { outcome: OUTCOMES.existing, errors: [], record };
  }

  const customerId = resolveCustomer(record, lookups);
  if (!customerId) errors.push('customer not found');
  const staffId = resolveTechnician(record, lookups);
  const technicianGiven = !isBlank(record.technicianExternalId) || !isBlank(record.technicianEmail);
  if (technicianGiven && !staffId) errors.push('technician not found');
  const services = resolveServices(record, lookups);
  if (services.missing.length) errors.push(`service not found: ${services.missing.join(', ')}`);

  const validation = validateAppointment({
    customerId: customerId ?? undefined,
    appointmentDate: record.appointmentDate,
    startTime: record.startTime,
    endTime: record.endTime,
    status: record.status,
    category: record.category,
  });
  errors.push(...validation.errors.filter((error) => error !== 'customerId is required'));

  if (errors.length) return { outcome: OUTCOMES.failed, errors, record };
  return {
    outcome: OUTCOMES.ready,
    errors: [],
    record,
    appointment: {
      externalSource: String(record.externalSource),
      externalId: String(record.externalId),
      customerId,
      staffId: staffId ?? null,
      serviceIds: services.ids,
      category: validation.record.category,
      status: validation.record.status,
      // derived from the start time, exactly as the database does for every saved appointment
      appointmentDate: validation.record.appointmentDate,
      startTime: record.startTime,
      endTime: isBlank(record.endTime) ? null : record.endTime,
      notes: isBlank(record.notes) ? null : String(record.notes),
    },
  };
}

function stageImport(records, lookups) {
  const seenInBatch = new Set();
  const results = (Array.isArray(records) ? records : []).map((record, index) => ({
    index,
    ...stageRecord(record, lookups, seenInBatch),
  }));
  const summary = { total: results.length };
  for (const outcome of Object.values(OUTCOMES)) summary[outcome] = 0;
  for (const result of results) summary[result.outcome] += 1;
  return {
    summary,
    ready: results.filter((result) => result.outcome === OUTCOMES.ready).map((result) => result.appointment),
    report: results
      .filter((result) => result.outcome !== OUTCOMES.ready)
      .map(({ index, outcome, errors, record }) => ({
        index,
        outcome,
        errors,
        externalId: record?.externalId ?? null,
      })),
  };
}

module.exports = { OUTCOMES, createLookups, stageImport, stageRecord, normaliseEmail, normalisePhone };
