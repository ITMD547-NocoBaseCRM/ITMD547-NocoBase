type Period = { start: string; end: string };
type AvailabilitySettings = { timeZone: string; slotIntervalMinutes: number; defaultDurationMinutes: number };
type Range = { start: Date; end: Date };
type Snapshot = { settings: AvailabilitySettings; staff: any[]; shifts: any[]; overrides: any[]; leaves: any[]; appointments: any[] };

const DEFAULT_SETTINGS: AvailabilitySettings = {
  timeZone: 'America/Chicago',
  slotIntervalMinutes: 15,
  defaultDurationMinutes: 60,
};
const UNAVAILABLE_STATUSES = ['cancelled', 'noShow'];

function plain(record: any) {
  return record?.get ? record.get({ plain: true }) : record;
}

function dateParts(value: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(value).reduce<Record<string, string>>((result, part) => {
    result[part.type] = part.value;
    return result;
  }, {});
  return parts;
}

function localDate(value: Date, timeZone: string) {
  const parts = dateParts(value, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function weekday(date: string, timeZone: string) {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(new Date(`${date}T12:00:00Z`));
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(name);
}

// Convert a business-local date/time into an instant. The second pass handles daylight-saving offsets.
function atBusinessTime(date: string, time: string, timeZone: string) {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const utc = Date.UTC(year, month - 1, day, hour, minute || 0);
  const offsetAt = (instant: number) => {
    const p = dateParts(new Date(instant), timeZone);
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second || 0)) - instant;
  };
  let instant = utc - offsetAt(utc);
  instant = utc - offsetAt(instant);
  return new Date(instant);
}

function asPeriods(value: unknown): Period[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item: any) => item && /^\d{2}:\d{2}$/.test(item.start) && /^\d{2}:\d{2}$/.test(item.end) && item.start < item.end);
}

function addDays(date: string, days: number) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function dateOnlyValue(value: unknown) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return typeof value === 'string' ? value.slice(0, 10) : '';
}

export class AvailabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AvailabilityError';
  }
}

export class AvailabilityService {
  constructor(private db: any, private transaction?: any) {}

  async lockStaff(staffIds: Array<number | string | null | undefined>) {
    if (!this.transaction) return; // Read-only availability checks do not acquire write locks.
    const ids = [...new Set(staffIds.filter((id) => id != null).map(String))];
    if (!ids.length) return;
    // All scheduling mutations lock the same staff rows in the same order. A second
    // booking/leave/shift change then validates after the first transaction commits.
    await this.db.getModel('staff').findAll({
      where: { id: ids }, attributes: ['id'], order: [['id', 'ASC']],
      transaction: this.transaction, lock: this.transaction.LOCK?.UPDATE || 'UPDATE',
    });
  }

  private repository(name: string) {
    const repo = this.db.getRepository(name);
    return {
      find: (options: any = {}) => repo.find({ ...options, transaction: this.transaction }),
      findOne: (options: any = {}) => repo.findOne({ ...options, transaction: this.transaction }),
      update: (options: any) => repo.update({ ...options, transaction: this.transaction }),
      destroy: (options: any) => repo.destroy({ ...options, transaction: this.transaction }),
      createMany: (options: any) => repo.createMany({ ...options, transaction: this.transaction }),
    };
  }

  async settings(): Promise<AvailabilitySettings> {
    const record = await this.repository('appointmentAvailabilitySettings').findOne({});
    return { ...DEFAULT_SETTINGS, ...(plain(record) || {}) };
  }

  async assertShiftOutsideLeave(shift: any) {
    if (!shift.staffId || ['cancelled', 'onLeave'].includes(shift.status)) return;
    const start = new Date(shift.startTime);
    const end = new Date(shift.endTime);
    // Leave ordinary form validation to the existing shift workflow.
    if (!Number.isFinite(+start) || !Number.isFinite(+end) || end <= start) return;
    const record = await this.repository('staffAvailabilityLeaves').findOne({
      filter: { staffId: shift.staffId, startTime: { $lt: end }, endTime: { $gt: start } },
      sort: ['startTime', 'id'],
    });
    if (!record) return;
    const leave = plain(record);
    const [settings, member] = await Promise.all([
      this.settings(),
      this.repository('staff').findOne({ filter: { id: shift.staffId }, fields: ['firstName', 'lastName'] }),
    ]);
    const staff = plain(member);
    const name = [staff?.firstName, staff?.lastName].filter(Boolean).join(' ').trim() || 'This staff member';
    const from = new Date(leave.startTime);
    const to = new Date(leave.endTime);
    const fromParts = dateParts(from, settings.timeZone);
    const toParts = dateParts(to, settings.timeZone);
    const allDay = [fromParts, toParts].every((p) => p.hour === '00' && p.minute === '00' && p.second === '00');
    const format = new Intl.DateTimeFormat('en-US', {
      timeZone: settings.timeZone, month: 'short', day: 'numeric', year: 'numeric',
      ...(!allDay ? { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' as const } : {}),
    });
    // All-day leave has an exclusive midnight end: Oct 23 -> Oct 24 means Oct 23 only.
    const last = allDay ? new Date(+to - 1) : to;
    const period = allDay && localDate(from, settings.timeZone) === localDate(last, settings.timeZone)
      ? `on ${format.format(from)}`
      : `from ${format.format(from)} to ${format.format(last)}`;
    throw new AvailabilityError(`${name} is on leave ${period}. Choose another staff member or date, or update the saved leave before scheduling this shift.`);
  }

  private async snapshot(start: Date, end: Date, staffId?: number | string, configuration?: AvailabilitySettings): Promise<Snapshot> {
    const settings = configuration || await this.settings();
    const first = localDate(start, settings.timeZone);
    const last = localDate(new Date(end.getTime() - 1), settings.timeZone);
    const from = atBusinessTime(first, '00:00', settings.timeZone);
    const to = atBusinessTime(addDays(last, 1), '00:00', settings.timeZone);
    const owner = staffId ? [{ staffId }] : [];
    const overlap = [{ startTime: { $lt: to } }, { endTime: { $gt: from } }];
    const [staff, shifts, overrides, leaves, appointments] = await Promise.all([
      this.repository('staff').find({ ...(staffId ? { filter: { id: staffId } } : {}), fields: ['id', 'firstName', 'lastName', 'active'] }),
      this.repository('employeeShifts').find({ filter: { $and: [...owner, ...overlap] } }),
      this.repository('staffAvailabilityOverrides').find({ filter: { $and: [...owner, { date: { $gte: first } }, { date: { $lte: last } }] }, sort: ['-updatedAt', '-id'] }),
      this.repository('staffAvailabilityLeaves').find({ filter: { $and: [...owner, ...overlap] } }),
      this.repository('appointments').find({ filter: { $and: [...owner, { status: { $notIn: UNAVAILABLE_STATUSES } }, { startTime: { $lt: to } }, { $or: [{ endTime: { $gt: from } }, { endTime: null }] }] }, fields: ['id', 'staffId', 'startTime', 'endTime', 'status'] }),
    ]);
    return { settings, staff: staff.map(plain), shifts: shifts.map(plain), overrides: overrides.map(plain), leaves: leaves.map(plain), appointments: appointments.map(plain) };
  }

  private ranges(snapshot: Snapshot, staffId: number | string, start: Date, end: Date): Range[] {
    const sameStaff = (row: any) => String(row.staffId) === String(staffId);
    const ranges: Range[] = [];
    const timeZone = snapshot.settings.timeZone;
    for (let date = localDate(start, timeZone); date <= localDate(new Date(end.getTime() - 1), timeZone); date = addDays(date, 1)) {
      const dayStart = atBusinessTime(date, '00:00', timeZone);
      const dayEnd = atBusinessTime(addDays(date, 1), '00:00', timeZone);
      const override = snapshot.overrides.find((row) => sameStaff(row) && dateOnlyValue(row.date) === date);
      if (override) {
        if (override.isWorking) for (const period of asPeriods(override.periods)) ranges.push({ start: atBusinessTime(date, period.start, timeZone), end: atBusinessTime(date, period.end, timeZone) });
      } else {
        for (const shift of snapshot.shifts.filter((row) => {
          if (!sameStaff(row) || row.status === 'cancelled') return false;
          if (row.status !== 'onLeave') return true;
          // A projected partial leave marks the whole calendar tile as onLeave.
          // Keep its base hours and let the exact leave interval below exclude only time away.
          const notes = String(row.notes || '');
          return notes.includes('[Availability schedule ') && snapshot.leaves.some((leave) => sameStaff(leave) && notes.includes(`[Availability leave ${leave.id}]`));
        })) {
          const from = new Date(Math.max(new Date(shift.startTime).getTime(), dayStart.getTime()));
          const to = new Date(Math.min(new Date(shift.endTime).getTime(), dayEnd.getTime()));
          if (from < to) ranges.push({ start: from, end: to });
        }
      }
    }
    const merged: Range[] = [];
    for (const range of ranges.sort((a, b) => +a.start - +b.start)) {
      const previous = merged[merged.length - 1];
      if (previous && range.start <= previous.end) previous.end = new Date(Math.max(+previous.end, +range.end));
      else merged.push({ ...range });
    }
    return merged;
  }

  private unavailableReason(snapshot: Snapshot, staffId: number | string, start: Date, end: Date, excludeAppointmentId?: number | string) {
    const sameStaff = (row: any) => String(row.staffId) === String(staffId);
    const staff = snapshot.staff.find((row) => String(row.id) === String(staffId));
    if (!staff || !['active', true].includes(staff.active)) return 'This staff member is inactive or no longer exists.';
    if (snapshot.leaves.some((row) => sameStaff(row) && new Date(row.startTime) < end && new Date(row.endTime) > start)) return 'This time overlaps staff leave.';
    if (!this.ranges(snapshot, staffId, start, end).some((range) => start >= range.start && end <= range.end)) return 'This time is outside the staff member’s available schedule.';
    if (snapshot.appointments.some((row) => sameStaff(row) && String(row.id) !== String(excludeAppointmentId || '') && new Date(row.startTime) < end && new Date(row.endTime || new Date(+new Date(row.startTime) + snapshot.settings.defaultDurationMinutes * 60000)) > start)) return 'This staff member already has an appointment at that time.';
    return '';
  }

  async availableStaff(input: { startTime: string | Date; endTime?: string | Date; excludeAppointmentId?: number | string }) {
    const settings = await this.settings();
    const start = new Date(input.startTime);
    const end = input.endTime ? new Date(input.endTime) : new Date(+start + settings.defaultDurationMinutes * 60000);
    if (!Number.isFinite(+start) || !Number.isFinite(+end) || end <= start) throw new AvailabilityError('Choose a valid appointment start and end time.');
    const snapshot = await this.snapshot(start, end, undefined, settings);
    return { staff: snapshot.staff.filter((row) => !this.unavailableReason(snapshot, row.id, start, end, input.excludeAppointmentId)).map((row) => ({ id: row.id, firstName: row.firstName, lastName: row.lastName })) };
  }

  async assertShiftChange(shift: any, previous: any, deleting = false, removedIds: Array<number | string> = []) {
    if (!previous?.staffId) return;
    const start = new Date(previous.startTime);
    const end = new Date(previous.endTime);
    if (!Number.isFinite(+start) || !Number.isFinite(+end) || end <= start) return;
    const snapshot = await this.snapshot(start, end, previous.staffId);
    const affected = snapshot.appointments.filter((row) => ['scheduled', 'confirmed', 'inProgress'].includes(row.status) && new Date(row.startTime) < end && new Date(row.endTime || +new Date(row.startTime) + 3600000) > start);
    const excluded = new Set([previous.id, ...removedIds].map(String));
    snapshot.shifts = snapshot.shifts.filter((row) => !excluded.has(String(row.id)));
    if (!deleting) snapshot.shifts.push(shift);
    for (const appointment of affected) {
      const from = new Date(appointment.startTime);
      const to = new Date(appointment.endTime || +from + snapshot.settings.defaultDurationMinutes * 60000);
      if (this.unavailableReason(snapshot, previous.staffId, from, to, appointment.id)) throw new AvailabilityError('This shift change would leave an appointment without available staff. Reassign or unassign the appointment first, then update the shift.');
    }
  }

  async assertOverrideChange(override: any, previous?: any, deleting = false, removedIds: Array<number | string> = []) {
    const targets = [previous, override].filter((row) => row?.staffId && row?.date);
    for (const target of targets) {
      const settings = await this.settings();
      const date = dateOnlyValue(target.date);
      const start = atBusinessTime(date, '00:00', settings.timeZone);
      const end = atBusinessTime(addDays(date, 1), '00:00', settings.timeZone);
      const snapshot = await this.snapshot(start, end, target.staffId);
      const excluded = new Set([previous?.id || override?.id || '', ...removedIds].map(String));
      snapshot.overrides = snapshot.overrides.filter((row) => !excluded.has(String(row.id)));
      if (!deleting && override) snapshot.overrides.unshift(override);
      for (const appointment of snapshot.appointments.filter((row) => ['scheduled', 'confirmed', 'inProgress'].includes(row.status))) {
        const from = new Date(appointment.startTime);
        const to = new Date(appointment.endTime || +from + settings.defaultDurationMinutes * 60000);
        if (this.unavailableReason(snapshot, target.staffId, from, to, appointment.id)) throw new AvailabilityError('This availability change conflicts with an appointment. Reassign or unassign it first.');
      }
    }
  }

  async assertStaffChange(staff: any) {
    if (['active', true].includes(staff.active)) return;
    const settings = await this.settings();
    const appointments = await this.repository('appointments').find({ filter: { $and: [
      { staffId: staff.id }, { status: { $in: ['scheduled', 'confirmed', 'inProgress'] } },
      { $or: [{ endTime: { $gt: new Date() } }, { status: 'inProgress' }, { endTime: null, startTime: { $gte: new Date(Date.now() - settings.defaultDurationMinutes * 60000) } }] },
    ] }, fields: ['id'], limit: 1 });
    if (appointments.length) throw new AvailabilityError('This staff member has upcoming appointments. Reassign or unassign them before marking staff inactive.');
  }

  async getWorkingPeriods(staffId: number | string, date: string): Promise<{ periods: Period[]; source: 'leave' | 'shift' | 'none'; settings: AvailabilitySettings }> {
    const settings = await this.settings();
    const dayStart = atBusinessTime(date, '00:00', settings.timeZone);
    const dayEnd = atBusinessTime(addDays(date, 1), '00:00', settings.timeZone);
    const snapshot = await this.snapshot(dayStart, dayEnd, staffId);
    const ranges = this.ranges(snapshot, staffId, dayStart, dayEnd);
    if (!ranges.length) return { periods: [], source: snapshot.leaves.length ? 'leave' : 'none', settings };
    const clock = (value: Date | string) => {
      const parts = dateParts(new Date(value), settings.timeZone);
      return `${parts.hour}:${parts.minute}`;
    };
    return {
      periods: ranges.map((range) => ({ start: clock(range.start), end: clock(range.end) })),
      source: 'shift',
      settings,
    };
  }

  async hasLeaveConflict(staffId: number | string, start: Date, end: Date) {
    const leaves = await this.repository('staffAvailabilityLeaves').find({
      filter: { $and: [{ staffId }, { startTime: { $lt: end } }, { endTime: { $gt: start } }] },
      fields: ['id'], limit: 1,
    });
    return leaves.length > 0;
  }

  async businessDayRange(date: string) {
    const settings = await this.settings();
    return {
      start: atBusinessTime(date, '00:00', settings.timeZone),
      end: atBusinessTime(date, '23:59', settings.timeZone),
    };
  }

  async assertAvailable(input: { staffId?: number | string; startTime: Date | string; endTime?: Date | string; durationMinutes?: number; excludeAppointmentId?: number | string }) {
    if (!input.staffId) return; // Appointments may be deliberately unassigned.
    const start = new Date(input.startTime);
    if (Number.isNaN(start.getTime())) throw new AvailabilityError('Choose a valid appointment start time.');
    const settings = await this.settings();
    const end = input.endTime ? new Date(input.endTime) : new Date(start.getTime() + (input.durationMinutes || settings.defaultDurationMinutes) * 60000);
    if (Number.isNaN(end.getTime()) || end <= start) throw new AvailabilityError('Appointment end time must be after the start time.');
    const snapshot = await this.snapshot(start, end, input.staffId, settings);
    const reason = this.unavailableReason(snapshot, input.staffId, start, end, input.excludeAppointmentId);
    if (reason) throw new AvailabilityError(reason);
  }

  async slots(input: { staffId: number | string; date: string; durationMinutes?: number; excludeAppointmentId?: number | string }) {
    const settings = await this.settings();
    const duration = input.durationMinutes || settings.defaultDurationMinutes;
    if (!Number.isFinite(duration) || duration <= 0) throw new AvailabilityError('Choose a valid service duration.');
    const start = atBusinessTime(input.date, '00:00', settings.timeZone);
    const endOfDay = atBusinessTime(addDays(input.date, 1), '00:00', settings.timeZone);
    const snapshot = await this.snapshot(start, endOfDay, input.staffId, settings);
    const ranges = this.ranges(snapshot, input.staffId, start, endOfDay);
    const slots: Array<{ startTime: string; endTime: string }> = [];
    const interval = Math.max(1, Number(settings.slotIntervalMinutes) || 15);
    for (const range of ranges) {
      let cursor = range.start;
      while (cursor.getTime() + duration * 60000 <= range.end.getTime()) {
        const end = new Date(cursor.getTime() + duration * 60000);
        if (!this.unavailableReason(snapshot, input.staffId, cursor, end, input.excludeAppointmentId)) {
          slots.push({ startTime: cursor.toISOString(), endTime: end.toISOString() });
        }
        cursor = new Date(cursor.getTime() + interval * 60000);
      }
    }
    const source = ranges.length ? 'shift' : snapshot.leaves.length ? 'leave' : 'none';
    return { date: input.date, timeZone: settings.timeZone, source, slots };
  }

  async projectScheduleToEmployeeShifts(input: unknown) {
    const schedule = plain(input);
    const effectiveFrom = dateOnlyValue(schedule?.effectiveFrom);
    const effectiveTo = dateOnlyValue(schedule?.effectiveTo);
    if (!schedule?.id || !schedule.staffId || !effectiveFrom || !schedule.isWorking) return 0;

    const marker = `[Availability schedule ${schedule.id}]`;
    const shifts = this.repository('employeeShifts');
    const existing = await shifts.find({ filter: { notes: { $includes: marker } }, fields: ['id', 'staffId', 'startTime', 'endTime'] });

    const settings = await this.settings();
    const today = localDate(new Date(), settings.timeZone);
    const firstDate = effectiveFrom > today ? effectiveFrom : today;
    const horizon = addDays(today, 89);
    const lastDate = effectiveTo && effectiveTo < horizon ? effectiveTo : horizon;
    if (lastDate < firstDate) return 0;

    const records: Array<Record<string, unknown>> = [];
    const periods = asPeriods(schedule.periods);
    for (let date = firstDate; date <= lastDate; date = addDays(date, 1)) {
      if (weekday(date, settings.timeZone) !== Number(schedule.weekday)) continue;
      for (const period of periods) {
        const startTime = atBusinessTime(date, period.start, settings.timeZone);
        const endTime = atBusinessTime(date, period.end, settings.timeZone);
        records.push({
          staffId: schedule.staffId,
          shiftDate: date,
          startTime,
          endTime,
          shiftType: 'availability',
          status: 'scheduled',
          calendarTitle: 'Available',
          notes: `${marker}${schedule.notes ? ` ${schedule.notes}` : ''}`,
        });
      }
    }
    // A manually entered shift for the same hours already shows the staff member as working,
    // so generating another one would just double it on the calendar.
    const manual = (await shifts.find({
      filter: { $and: [{ staffId: schedule.staffId }, { shiftDate: { $gte: firstDate } }, { shiftDate: { $lte: lastDate } }, { shiftType: { $ne: 'availability' } }, { status: { $ne: 'cancelled' } }] },
      fields: ['startTime', 'endTime'],
    })).map((item: any) => plain(item));
    const covered = (record: Record<string, any>) => manual.some((item: any) => new Date(item.startTime) <= new Date(record.startTime as any) && new Date(item.endTime) >= new Date(record.endTime as any));
    const fresh = records.filter((record) => !covered(record) && !existing.some((item: any) => String(plain(item).staffId) === String(record.staffId) && +new Date(plain(item).startTime) === +new Date(record.startTime as any) && +new Date(plain(item).endTime) === +new Date(record.endTime as any)));
    if (!fresh.length) return 0;
    await shifts.createMany({ records: fresh });
    return fresh.length;
  }

  async clearScheduleProjection(input: unknown) {
    const schedule = plain(input);
    if (!schedule?.id) return;
    const settings = await this.settings();
    const today = localDate(new Date(), settings.timeZone);
    await this.repository('employeeShifts').destroy({ filter: { $and: [{ notes: { $includes: `[Availability schedule ${schedule.id}]` } }, { startTime: { $gte: atBusinessTime(today, '00:00', settings.timeZone) } }] } });
  }

  async reconcileScheduleProjection(input: unknown) {
    const schedule = plain(input);
    if (!schedule?.id) return;
    // Add final coverage first so expanding/changing a schedule does not temporarily
    // strand an appointment while its original generated shifts are removed.
    await this.projectScheduleToEmployeeShifts(schedule);
    await this.applyExistingLeaves(schedule.staffId);
    const settings = await this.settings();
    const today = localDate(new Date(), settings.timeZone);
    const shifts = this.repository('employeeShifts');
    const generated = (await shifts.find({ filter: { notes: { $includes: `[Availability schedule ${schedule.id}]` } } })).map(plain);
    const obsolete = generated.filter((shift: any) => {
      const date = localDate(new Date(shift.startTime), settings.timeZone);
      if (date < today) return false; // Historical shift records are retained.
      return !schedule.isWorking || String(shift.staffId) !== String(schedule.staffId)
        || date < dateOnlyValue(schedule.effectiveFrom) || (!!schedule.effectiveTo && date > dateOnlyValue(schedule.effectiveTo))
        || weekday(date, settings.timeZone) !== Number(schedule.weekday)
        || !asPeriods(schedule.periods).some((period) => +atBusinessTime(date, period.start, settings.timeZone) === +new Date(shift.startTime) && +atBusinessTime(date, period.end, settings.timeZone) === +new Date(shift.endTime));
    });
    if (obsolete.length) await shifts.destroy({ filterByTk: obsolete.map((shift: any) => shift.id) });
  }

  async projectExistingSchedules() {
    const schedules = await this.repository('staffAvailabilitySchedules').find({ filter: { isWorking: true } });
    for (const schedule of schedules) await this.projectScheduleToEmployeeShifts(schedule);
  }

  /**
   * Keep an availability shift on the calendar while a staff member is away.
   * Only shifts generated by this plugin are changed; manually maintained
   * employee shifts keep their own status and are never overwritten.
   */
  async applyLeaveToEmployeeShifts(input: unknown) {
    const leave = plain(input);
    const start = new Date(leave?.startTime);
    const end = new Date(leave?.endTime);
    if (!leave?.id || !leave.staffId || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return 0;

    const marker = `[Availability leave ${leave.id}]`;
    const staffName = await this.staffDisplayName(leave.staffId);
    const calendarTitle = `On leave — ${staffName}`;
    const shifts = this.repository('employeeShifts');
    const generatedShifts = await shifts.find({
      filter: {
        $and: [
          { staffId: leave.staffId },
          { notes: { $includes: '[Availability schedule ' } },
          { startTime: { $lt: end } },
          { endTime: { $gt: start } },
        ],
      },
    });

    let updated = 0;
    for (const record of generatedShifts) {
      const shift = plain(record);
      const notes = typeof shift.notes === 'string' ? shift.notes : '';
      if (notes.includes(marker)) {
        if (shift.status === 'onLeave' && shift.calendarTitle === calendarTitle) continue;
        await shifts.update({ filterByTk: shift.id, values: { status: 'onLeave', calendarTitle } });
        updated += 1;
        continue;
      }
      await shifts.update({
        filterByTk: shift.id,
        values: {
          status: 'onLeave',
          calendarTitle,
          notes: `${notes}${notes ? ' ' : ''}${marker}`,
        },
      });
      updated += 1;
    }
    return updated;
  }

  async clearLeaveProjection(input: unknown) {
    const leave = plain(input);
    if (!leave?.id) return 0;

    const marker = `[Availability leave ${leave.id}]`;
    const shifts = this.repository('employeeShifts');
    const leaveShifts = await shifts.find({ filter: { notes: { $includes: marker } } });
    let updated = 0;
    for (const record of leaveShifts) {
      const shift = plain(record);
      const notes = typeof shift.notes === 'string' ? shift.notes : '';
      const remainingNotes = notes.replace(marker, '').replace(/\s{2,}/g, ' ').trim();
      const hasAnotherLeave = remainingNotes.includes('[Availability leave ');
      await shifts.update({
        filterByTk: shift.id,
        values: {
          notes: remainingNotes,
          ...(hasAnotherLeave ? {} : { status: 'scheduled', calendarTitle: 'Available' }),
        },
      });
      updated += 1;
    }
    return updated;
  }

  async applyExistingLeaves(staffId?: number | string) {
    const leaves = await this.repository('staffAvailabilityLeaves').find({
      ...(staffId ? { filter: { staffId } } : {}),
    });
    for (const leave of leaves) await this.applyLeaveToEmployeeShifts(leave);
  }

  private async staffDisplayName(staffId: number | string) {
    const staff = await this.repository('staff').find({
      filter: { id: staffId },
      fields: ['firstName', 'lastName'],
      limit: 1,
    });
    const record = plain(staff[0]);
    const name = [record?.firstName, record?.lastName]
      .filter((part) => typeof part === 'string' && part.trim())
      .join(' ')
      .trim();
    return name || 'Staff member';
  }

  /**
   * Appointments a leave period would strand, each with the other staff members who could take it.
   * Used by the leave form to ask who should cover before the leave is saved.
   */
  async leaveConflicts(input: { staffId: number | string; startTime: Date | string; endTime: Date | string }) {
    const start = new Date(input.startTime);
    const end = new Date(input.endTime);
    if (!input.staffId || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return [];
    const settings = await this.settings();
    const appointments = await this.repository('appointments').find({
      filter: { $and: [
        { staffId: input.staffId },
        { status: { $in: ['scheduled', 'confirmed', 'inProgress'] } },
        { startTime: { $lt: end } },
        { $or: [{ endTime: { $gt: start } }, { endTime: null }] },
      ] },
      appends: ['customer'],
      sort: ['startTime'],
    });
    const result = [];
    for (const record of appointments) {
      const appointment = plain(record);
      const appointmentEnd = appointment.endTime || new Date(+new Date(appointment.startTime) + settings.defaultDurationMinutes * 60000).toISOString();
      if (new Date(appointmentEnd) <= start) continue;
      const available = await this.availableStaff({ startTime: appointment.startTime, endTime: appointmentEnd, excludeAppointmentId: appointment.id });
      const candidates = available.staff.filter((staff) => String(staff.id) !== String(input.staffId)).map((staff) => ({ id: staff.id, name: [staff.firstName, staff.lastName].filter(Boolean).join(' ') || 'Staff member' }));
      const customer = plain(appointment.customer);
      result.push({
        id: appointment.id,
        startTime: appointment.startTime,
        endTime: appointmentEnd,
        status: appointment.status,
        customerName: [customer?.firstName, customer?.lastName].filter(Boolean).join(' ') || 'Customer',
        candidates,
      });
    }
    return result;
  }

  async assertNoAppointmentsWouldBeInvalidated(staffId: number | string, start: Date, end: Date) {
    const settings = await this.settings();
    const appointments = await this.repository('appointments').find({
      filter: { $and: [{ staffId }, { status: { $in: ['scheduled', 'confirmed', 'inProgress'] } }, { startTime: { $lt: end } }, { $or: [{ endTime: { $gt: start } }, { endTime: null }] }] },
      fields: ['id', 'startTime', 'endTime'],
    });
    if (appointments.some((record: any) => {
      const appointment = plain(record);
      return new Date(appointment.endTime || +new Date(appointment.startTime) + settings.defaultDurationMinutes * 60000) > start;
    })) {
      throw new AvailabilityError('This change conflicts with an existing appointment. Reschedule the appointment first.');
    }
  }
}
