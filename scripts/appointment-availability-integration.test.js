// Regression tests execute the plugin service itself with isolated repository data.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

function loadTs(relative, overrides = {}) {
  const filename = path.resolve(relative);
  const compiled = new Module(filename, module);
  compiled.filename = filename;
  compiled.paths = module.paths;
  compiled.require = (name) => overrides[name] || require(name);
  compiled._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename);
  return compiled.exports;
}
const servicePath = 'packages/plugins/@parlour/plugin-appointment-availability/src/server/availability-service.ts';
const { AvailabilityService, AvailabilityError } = loadTs(servicePath);
const pluginPath = 'packages/plugins/@parlour/plugin-appointment-availability/src/server/plugin.ts';
const { PluginAppointmentAvailabilityServer } = loadTs(pluginPath, { '@nocobase/server': { Plugin: class {} }, './availability-service': { AvailabilityService, AvailabilityError } });

const start = '2026-10-22T14:07:00Z'; // 9:07 AM Chicago
const end = '2026-10-22T15:07:00Z';
const shift = { id: 10, staffId: 1, status: 'scheduled', startTime: '2026-10-22T14:00:00Z', endTime: '2026-10-22T22:00:00Z' };
const appointment = { id: 20, staffId: 1, status: 'confirmed', startTime: start, endTime: end };
const comparable = (value) => value instanceof Date ? value.toISOString() : typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) ? new Date(value).toISOString() : value;
function matches(row, filter = {}) {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === '$and') return expected.every((part) => matches(row, part));
    if (key === '$or') return expected.some((part) => matches(row, part));
    const actual = comparable(row[key]);
    if (expected && typeof expected === 'object' && !(expected instanceof Date)) return Object.entries(expected).every(([op, val]) => {
      const target = comparable(val);
      if (op === '$in') return val.includes(row[key]);
      if (op === '$notIn') return !val.includes(row[key]);
      if (op === '$ne') return String(actual) !== String(target);
      if (op === '$lt') return actual < target;
      if (op === '$lte') return actual <= target;
      if (op === '$gt') return actual > target;
      if (op === '$gte') return actual >= target;
      if (op === '$includes') return String(actual || '').includes(val);
      throw new Error('Unknown test filter: ' + op);
    });
    return expected == null ? row[key] == null : String(actual) === String(comparable(expected));
  });
}
function fixture(extra = {}, transaction) {
  const data = {
    appointmentAvailabilitySettings: [{ timeZone: 'America/Chicago', slotIntervalMinutes: 15, defaultDurationMinutes: 60 }],
    staff: [{ id: 1, firstName: 'Test', lastName: 'Staff', active: 'active' }],
    employeeShifts: [{ ...shift }], staffAvailabilityLeaves: [], staffAvailabilityOverrides: [], appointments: [], ...extra,
  };
  const reads = [];
  const db = { getRepository: (name) => ({
    find: async (options = {}) => { reads.push({ name, options }); return (data[name] || []).filter((row) => matches(row, options.filter) && (options.filterByTk == null || String(row.id) === String(options.filterByTk))).slice(0, options.limit || Infinity); },
    findOne: async (options = {}) => { reads.push({ name, options }); return (data[name] || []).find((row) => matches(row, options.filter)); },
    update: async (options) => { for (const row of data[name] || []) if (String(row.id) === String(options.filterByTk)) Object.assign(row, options.values); },
    destroy: async (options) => { data[name] = (data[name] || []).filter((row) => options.filterByTk ? !(Array.isArray(options.filterByTk) ? options.filterByTk : [options.filterByTk]).map(String).includes(String(row.id)) : !matches(row, options.filter)); },
    createMany: async (options) => { const created = options.records.map((row, i) => ({ ...row, id: 1000 + data[name].length + i })); data[name].push(...created); return created; },
  }) };
  return { data, reads, db, service: new AvailabilityService(db, transaction) };
}

test('exact non-grid times are accepted by both available staff and booking validation', async () => {
  const { service, reads } = fixture();
  const available = await service.availableStaff({ startTime: start, endTime: end });
  assert.deepEqual(available.staff.map((row) => row.id), [1]);
  assert.equal(reads.length, 6, 'one batched snapshot independent of number of staff');
  await service.assertAvailable({ staffId: 1, startTime: start, endTime: end });
});

const hannahLeave = { id: 7, staffId: 1, startTime: '2026-10-23T05:00:00Z', endTime: '2026-10-24T05:00:00Z' };
const hannahShift = { ...shift, startTime: '2026-10-23T19:00:00Z', endTime: '2026-10-24T00:00:00Z' };
const hannahData = { staff: [{ id: 1, firstName: 'Hannah', lastName: 'Brooks', active: 'active' }], staffAvailabilityLeaves: [hannahLeave] };

test('a shift during saved leave explains who is away, when and how to resolve it', async () => {
  const { service } = fixture(hannahData);
  await assert.rejects(service.assertShiftOutsideLeave(hannahShift), {
    message: 'Hannah Brooks is on leave on Oct 23, 2026. Choose another staff member or date, or update the saved leave before scheduling this shift.',
  });
});

test('multi-day and partial leave messages use salon-local dates and exact times', async () => {
  const allDay = fixture({ ...hannahData, staffAvailabilityLeaves: [{ ...hannahLeave, startTime: '2026-10-22T05:00:00Z' }] });
  await assert.rejects(allDay.service.assertShiftOutsideLeave(hannahShift), /from Oct 22, 2026 to Oct 23, 2026/);
  const partial = fixture({ ...hannahData, staffAvailabilityLeaves: [{ ...hannahLeave, startTime: '2026-10-23T18:00:00Z', endTime: '2026-10-23T20:00:00Z' }] });
  await assert.rejects(partial.service.assertShiftOutsideLeave(hannahShift), /from Oct 23, 2026, 1:00 PM CDT to Oct 23, 2026, 3:00 PM CDT/);
});

test('leave message does not falsely block other staff, adjacent shifts, cancellations or leave entries', async () => {
  const { service } = fixture(hannahData);
  for (const proposed of [
    { ...hannahShift, staffId: 2 },
    { ...hannahShift, startTime: hannahLeave.endTime, endTime: '2026-10-24T10:00:00Z' },
    { ...hannahShift, startTime: '2026-10-23T00:00:00Z', endTime: hannahLeave.startTime },
    { ...hannahShift, status: 'cancelled' }, { ...hannahShift, status: 'onLeave' },
  ]) await service.assertShiftOutsideLeave(proposed);
});

async function shiftMiddleware(extra = {}) {
  const f = fixture({ ...hannahData, ...extra });
  const plugin = new PluginAppointmentAvailabilityServer();
  plugin.db = f.db;
  const registrations = [];
  plugin.app = { resourceManager: { use: (handler, options) => registrations.push({ handler, options }), define() {} }, acl: { allow() {} }, logger: { error() {} } };
  await plugin.load();
  return { ...f, ...registrations[0] };
}
function shiftContext(values, actionName = 'create', params = {}) {
  return { action: { resourceName: 'employeeShifts', actionName, params: { values, ...params } }, dataSource: { name: 'main' }, throw(status, message) { throw Object.assign(new Error(message), { status }); } };
}
test('native shift request reports leave before generic overlap workflow runs, after ACL', async () => {
  const { handler, options } = await shiftMiddleware();
  assert.equal(options.after, 'acl');
  assert.equal(options.before, 'parseVariables');
  let workflowCalled = false;
  await assert.rejects(handler(shiftContext({ ...hannahShift, staffId: undefined, staff: { id: 1 } }), async () => { workflowCalled = true; }), (error) => error.status === 409 && /Hannah Brooks is on leave on Oct 23/.test(error.message));
  assert.equal(workflowCalled, false);
});
test('native shift updates combine saved fields with changes and resolve the newly selected staff', async () => {
  const { handler } = await shiftMiddleware({ employeeShifts: [hannahShift] });
  await assert.rejects(handler(shiftContext({ status: 'scheduled' }, 'update', { filterByTk: 10 }), async () => {}), /Hannah Brooks is on leave/);
  let nextCalled = 0;
  await handler(shiftContext({ staff: { id: 2 } }, 'update', { filterByTk: 10 }), async () => { nextCalled++; });
  await handler(shiftContext({ notes: 'Notes only' }, 'update', { filterByTk: 10 }), async () => { nextCalled++; });
  assert.equal(nextCalled, 2);
});
test('normal shift overlaps still reach existing validation, and other resources are untouched', async () => {
  const { handler } = await shiftMiddleware();
  const ctx = shiftContext(shift);
  let nextCalled = 0;
  await handler(ctx, async () => { nextCalled++; });
  ctx.action.resourceName = 'appointments';
  ctx.action.params.values = hannahShift;
  await handler(ctx, async () => { nextCalled++; });
  assert.equal(nextCalled, 2);
});
test('leave, overlapping bookings and inactive staff are silently excluded', async () => {
  for (const extra of [
    { staffAvailabilityLeaves: [{ staffId: 1, startTime: start, endTime: end }] },
    { appointments: [appointment] },
    { staff: [{ id: 1, active: 'inactive' }] },
  ]) {
    const { service } = fixture(extra);
    assert.deepEqual((await service.availableStaff({ startTime: start, endTime: end })).staff, []);
    await assert.rejects(service.assertAvailable({ staffId: 1, startTime: start, endTime: end }));
  }
});
test('editing a booking excludes its own ID; cancelled/no-show bookings do not occupy the slot', async () => {
  const { service } = fixture({ appointments: [appointment] });
  assert.equal((await service.availableStaff({ startTime: start, endTime: end, excludeAppointmentId: 20 })).staff.length, 1);
  for (const status of ['cancelled', 'noShow']) {
    const f = fixture({ appointments: [{ ...appointment, status }] });
    assert.equal((await f.service.availableStaff({ startTime: start, endTime: end })).staff.length, 1);
  }
});
test('a day-off override wins over a scheduled shift; working override supplies exact hours', async () => {
  const override = { id: 3, staffId: 1, date: '2026-10-22', isWorking: false, periods: [] };
  assert.deepEqual((await fixture({ staffAvailabilityOverrides: [override] }).service.availableStaff({ startTime: start, endTime: end })).staff, []);
  const { service } = fixture({ employeeShifts: [], staffAvailabilityOverrides: [{ ...override, isWorking: true, periods: [{ start: '09:00', end: '12:00' }] }] });
  assert.equal((await service.availableStaff({ startTime: start, endTime: end })).staff.length, 1);
  assert.equal((await service.availableStaff({ startTime: '2026-10-22T18:00:00Z', endTime: '2026-10-22T19:00:00Z' })).staff.length, 0);
});
test('overnight shifts and appointments preserve their actual instants', async () => {
  const { service } = fixture({ employeeShifts: [{ ...shift, startTime: '2026-10-23T03:00:00Z', endTime: '2026-10-23T07:00:00Z' }] });
  assert.equal((await service.availableStaff({ startTime: '2026-10-23T04:30:00Z', endTime: '2026-10-23T06:30:00Z' })).staff.length, 1);
});
test('adjacent shifts provide continuous coverage but a real break cannot be crossed', async () => {
  const shifts = [{ ...shift, endTime: '2026-10-22T15:00:00Z' }, { ...shift, id: 11, startTime: '2026-10-22T15:00:00Z' }];
  assert.equal((await fixture({ employeeShifts: shifts }).service.availableStaff({ startTime: start, endTime: end })).staff.length, 1);
  shifts[1].startTime = '2026-10-22T15:05:00Z';
  assert.equal((await fixture({ employeeShifts: shifts }).service.availableStaff({ startTime: start, endTime: end })).staff.length, 0);
});
test('full-day slots use a fixed number of reads instead of querying for every candidate', async () => {
  const { service, reads } = fixture();
  assert.equal((await service.slots({ staffId: 1, date: '2026-10-22', durationMinutes: 60 })).slots.length, 29);
  assert.ok(reads.length <= 7);
});
test('shift cancellation, leave, deletion, shortening and staff changes cannot strand a booking', async () => {
  const { service } = fixture({ appointments: [appointment] });
  for (const proposed of [{ ...shift, status: 'cancelled' }, { ...shift, status: 'onLeave' }, { ...shift, staffId: 2 }, { ...shift, endTime: '2026-10-22T14:30:00Z' }]) await assert.rejects(service.assertShiftChange(proposed, shift), /Reassign or unassign/);
  await assert.rejects(service.assertShiftChange(null, shift, true), /Reassign or unassign/);
  await service.assertShiftChange({ ...shift }, shift);
});
test('alternative coverage permits a shift change; completed appointments do not block it', async () => {
  const a = fixture({ appointments: [appointment], employeeShifts: [shift, { ...shift, id: 11 }] });
  await a.service.assertShiftChange(null, shift, true);
  const b = fixture({ appointments: [{ ...appointment, status: 'completed' }] });
  await b.service.assertShiftChange(null, shift, true);
});
test('narrowing or deleting an override cannot invalidate existing bookings', async () => {
  const override = { id: 3, staffId: 1, date: '2026-10-22', isWorking: true, periods: [{ start: '09:00', end: '17:00' }] };
  const { service } = fixture({ appointments: [appointment], employeeShifts: [], staffAvailabilityOverrides: [override] });
  await assert.rejects(service.assertOverrideChange({ ...override, isWorking: false }, override), /Reassign or unassign/);
  await assert.rejects(service.assertOverrideChange(null, override, true), /Reassign or unassign/);
});
test('hook reads reuse the mutation transaction', async () => {
  const transaction = { id: 'test-transaction' };
  const { service, reads } = fixture({}, transaction);
  await service.assertAvailable({ staffId: 1, startTime: start, endTime: end });
  assert.ok(reads.length > 0);
  assert.ok(reads.every((read) => read.options.transaction === transaction));
});
test('reactivating a cancelled booking validates availability again', async () => {
  const f = fixture({ staffAvailabilityLeaves: [{ staffId: 1, startTime: start, endTime: end }] });
  const plugin = new PluginAppointmentAvailabilityServer();
  plugin.db = f.db;
  plugin.app = { logger: { error() {} } };
  const model = { get: () => ({ ...appointment, status: 'scheduled' }), changed: (key) => key === 'status', previous: () => 'cancelled' };
  await assert.rejects(plugin.validateAppointment(model), /staff leave/);
});
test('unassigned appointments remain allowed', async () => {
  await fixture().service.assertAvailable({ startTime: start, endTime: end });
});

test('partial leave on a generated shift blocks only the actual leave interval', async () => {
  const leave = { id: 5, staffId: 1, startTime: '2026-10-22T16:00:00Z', endTime: '2026-10-22T17:00:00Z' };
  const { service } = fixture({ employeeShifts: [{ ...shift, status: 'onLeave', notes: '[Availability schedule 2] [Availability leave 5]' }], staffAvailabilityLeaves: [leave] });
  assert.equal((await service.availableStaff({ startTime: start, endTime: end })).staff.length, 1);
  assert.equal((await service.availableStaff({ startTime: leave.startTime, endTime: leave.endTime })).staff.length, 0);
  assert.equal((await service.availableStaff({ startTime: leave.endTime, endTime: '2026-10-22T18:00:00Z' })).staff.length, 1);
});

test('deleting several duplicate shifts checks their combined removal', async () => {
  const { service } = fixture({ appointments: [appointment], employeeShifts: [shift, { ...shift, id: 11 }] });
  await service.assertShiftChange(null, shift, true);
  await assert.rejects(service.assertShiftChange(null, shift, true, [10, 11]), /Reassign or unassign/);
});

test('bulk deletion hooks use the complete selected set and the original transaction', async () => {
  const f = fixture({ appointments: [appointment], employeeShifts: [shift, { ...shift, id: 11 }] });
  const hooks = {};
  f.db.on = (event, handler) => { hooks[event] = handler; };
  f.db.getModel = () => ({ findAll: async () => f.data.employeeShifts.map((row) => ({ get: (key) => typeof key === 'string' ? row[key] : row })) });
  const plugin = new PluginAppointmentAvailabilityServer();
  plugin.db = f.db;
  await plugin.beforeLoad();
  const transaction = { id: 'bulk-delete' };
  await assert.rejects(hooks['employeeShifts.beforeBulkDestroy']({ where: {}, transaction }), /Reassign or unassign/);
  assert.ok(f.reads.every((read) => read.options.transaction === transaction));
});

test('deleting multiple overlapping overrides cannot bypass coverage protection', async () => {
  const override = { id: 3, staffId: 1, date: '2026-10-22', isWorking: true, periods: [{ start: '09:00', end: '17:00' }] };
  const { service } = fixture({ appointments: [appointment], employeeShifts: [], staffAvailabilityOverrides: [override, { ...override, id: 4 }] });
  await service.assertOverrideChange(null, override, true);
  await assert.rejects(service.assertOverrideChange(null, override, true, [3, 4]), /Reassign or unassign/);
});

test('editing a recurring schedule adds replacement coverage before removing old shifts', async () => {
  const future = new Date(Date.now() + 2 * 86400000);
  const date = future.toISOString().slice(0, 10);
  const weekday = new Date(date + 'T12:00:00Z').getUTCDay();
  const old = { ...shift, shiftType: 'availability', shiftDate: date, startTime: date + 'T15:00:00Z', endTime: date + 'T21:00:00Z', notes: '[Availability schedule 2]' };
  const { service, data } = fixture({ employeeShifts: [old] });
  let replacementPresentAtDeletion = false;
  const repository = service.db.getRepository;
  service.db.getRepository = (name) => {
    const repo = repository(name);
    return { ...repo, destroy: async (options) => { replacementPresentAtDeletion = data.employeeShifts.some((row) => row.id !== old.id); return repo.destroy(options); } };
  };
  await service.reconcileScheduleProjection({ id: 2, staffId: 1, effectiveFrom: date, effectiveTo: date, weekday, isWorking: true, periods: [{ start: '08:00', end: '18:00' }] });
  assert.ok(replacementPresentAtDeletion);
  assert.equal(data.employeeShifts.length, 1);
  assert.notEqual(data.employeeShifts[0].id, old.id);
});

test('concurrent bookings serialize on the staff row and recheck committed conflicts', { timeout: 3000 }, async () => {
  const f = fixture();
  const locks = [];
  const release = {};
  let tail = Promise.resolve();
  f.db.getModel = (name) => {
    assert.equal(name, 'staff');
    return { findAll: async (options) => {
      assert.equal(options.lock, 'UPDATE');
      assert.deepEqual(options.order, [['id', 'ASC']]);
      const previous = tail;
      tail = new Promise((resolve) => { release[options.transaction.id] = resolve; });
      await previous;
      locks.push(options.transaction.id);
      return [];
    } };
  };
  const plugin = new PluginAppointmentAvailabilityServer();
  plugin.db = f.db;
  plugin.app = { logger: { error() {} } };
  const model = (id) => ({ get: () => ({ ...appointment, id, status: 'scheduled' }), changed: () => true, previous: () => undefined });
  await plugin.validateAppointment(model(21), { transaction: { id: 'first' } });
  const second = plugin.validateAppointment(model(22), { transaction: { id: 'second' } });
  assert.deepEqual(locks, ['first']);
  f.data.appointments.push({ ...appointment, id: 21, status: 'scheduled' });
  release.first();
  try { await assert.rejects(second, /already has an appointment/); }
  finally { release.second(); }
  assert.deepEqual(locks, ['first', 'second']);
});

test('leave checks use the same default end time for bookings with no explicit end', async () => {
  const leaveStart = new Date('2026-10-22T15:00:00Z');
  const leaveEnd = new Date('2026-10-22T16:00:00Z');
  const older = fixture({ appointments: [{ ...appointment, startTime: '2026-10-22T12:00:00Z', endTime: null }] });
  await older.service.assertNoAppointmentsWouldBeInvalidated(1, leaveStart, leaveEnd);
  assert.deepEqual(await older.service.leaveConflicts({ staffId: 1, startTime: leaveStart, endTime: leaveEnd }), []);
  const overlapping = fixture({ appointments: [{ ...appointment, startTime: '2026-10-22T14:30:00Z', endTime: null }] });
  await assert.rejects(overlapping.service.assertNoAppointmentsWouldBeInvalidated(1, leaveStart, leaveEnd), /conflicts/);
  const conflicts = await overlapping.service.leaveConflicts({ staffId: 1, startTime: leaveStart, endTime: leaveEnd });
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].endTime, '2026-10-22T15:30:00.000Z');
});

test('staff cannot be deactivated with upcoming or in-progress bookings, including missing end times', async () => {
  const future = new Date(Date.now() + 3600000).toISOString();
  for (const row of [{ ...appointment, startTime: future, endTime: null }, { ...appointment, status: 'inProgress', endTime: null }]) {
    const { service } = fixture({ appointments: [row] });
    await assert.rejects(service.assertStaffChange({ id: 1, active: 'inactive' }), /Reassign or unassign/);
    await service.assertStaffChange({ id: 1, active: 'active' });
  }
});
