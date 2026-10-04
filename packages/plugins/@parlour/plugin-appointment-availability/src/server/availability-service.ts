type Period = { start: string; end: string };
type AvailabilitySettings = { timeZone: string; slotIntervalMinutes: number; defaultDurationMinutes: number };

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
  constructor(private db: any) {}

  async settings(): Promise<AvailabilitySettings> {
    const record = await this.db.getRepository('appointmentAvailabilitySettings').findOne({});
    return { ...DEFAULT_SETTINGS, ...(plain(record) || {}) };
  }

  async getWorkingPeriods(staffId: number | string, date: string): Promise<{ periods: Period[]; source: 'leave' | 'override' | 'schedule' | 'none'; settings: AvailabilitySettings }> {
    const settings = await this.settings();
    const overrides = await this.db.getRepository('staffAvailabilityOverrides').find({ filter: { staffId, date }, sort: ['-updatedAt'], limit: 1 });
    if (overrides.length) {
      const override = plain(overrides[0]);
      return { periods: override.isWorking ? asPeriods(override.periods) : [], source: 'override', settings };
    }

    const schedules = await this.db.getRepository('staffAvailabilitySchedules').find({
      filter: { $and: [{ staffId }, { weekday: weekday(date, settings.timeZone) }, { effectiveFrom: { $lte: date } }, { $or: [{ effectiveTo: null }, { effectiveTo: { $gte: date } }] }] },
      sort: ['-effectiveFrom', '-updatedAt'], limit: 1,
    });
    if (!schedules.length) return { periods: [], source: 'none', settings };
    const schedule = plain(schedules[0]);
    return { periods: schedule.isWorking ? asPeriods(schedule.periods) : [], source: 'schedule', settings };
  }

  async hasLeaveConflict(staffId: number | string, start: Date, end: Date) {
    const leaves = await this.db.getRepository('staffAvailabilityLeaves').find({
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
    if (await this.hasLeaveConflict(input.staffId, start, end)) throw new AvailabilityError('This time overlaps staff leave.');
    const date = localDate(start, settings.timeZone);
    const working = await this.getWorkingPeriods(input.staffId, date);
    const fitsPeriod = working.periods.some((period) => {
      const periodStart = atBusinessTime(date, period.start, settings.timeZone);
      const periodEnd = atBusinessTime(date, period.end, settings.timeZone);
      return start >= periodStart && end <= periodEnd;
    });
    if (!fitsPeriod) throw new AvailabilityError('This time is outside the staff member’s available schedule.');

    const conflicts = await this.db.getRepository('appointments').find({
      filter: { $and: [
        { staffId: input.staffId },
        { status: { $notIn: UNAVAILABLE_STATUSES } },
        { startTime: { $lt: end } },
        { endTime: { $gt: start } },
        ...(input.excludeAppointmentId ? [{ id: { $ne: input.excludeAppointmentId } }] : []),
      ] },
      fields: ['id'], limit: 1,
    });
    if (conflicts.length) throw new AvailabilityError('This staff member already has an appointment at that time.');
  }

  async slots(input: { staffId: number | string; date: string; durationMinutes?: number; excludeAppointmentId?: number | string }) {
    const working = await this.getWorkingPeriods(input.staffId, input.date);
    const duration = input.durationMinutes || working.settings.defaultDurationMinutes;
    const slots: Array<{ startTime: string; endTime: string }> = [];
    for (const period of working.periods) {
      let cursor = atBusinessTime(input.date, period.start, working.settings.timeZone);
      const periodEnd = atBusinessTime(input.date, period.end, working.settings.timeZone);
      while (cursor.getTime() + duration * 60000 <= periodEnd.getTime()) {
        const end = new Date(cursor.getTime() + duration * 60000);
        try {
          await this.assertAvailable({ ...input, startTime: cursor, endTime: end, excludeAppointmentId: input.excludeAppointmentId });
          slots.push({ startTime: cursor.toISOString(), endTime: end.toISOString() });
        } catch (error) {
          if (!(error instanceof AvailabilityError)) throw error;
        }
        cursor = new Date(cursor.getTime() + working.settings.slotIntervalMinutes * 60000);
      }
    }
    return { date: input.date, timeZone: working.settings.timeZone, source: working.source, slots };
  }

  async projectScheduleToEmployeeShifts(input: unknown) {
    const schedule = plain(input);
    const effectiveFrom = dateOnlyValue(schedule?.effectiveFrom);
    const effectiveTo = dateOnlyValue(schedule?.effectiveTo);
    if (!schedule?.id || !schedule.staffId || !effectiveFrom || !schedule.isWorking) return 0;

    const marker = `[Availability schedule ${schedule.id}]`;
    const shifts = this.db.getRepository('employeeShifts');
    const existing = await shifts.find({ filter: { notes: { $includes: marker } }, fields: ['id'], limit: 1 });
    if (existing.length) return 0;

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
    if (!records.length) return 0;
    await shifts.createMany({ records });
    return records.length;
  }

  async clearScheduleProjection(input: unknown) {
    const schedule = plain(input);
    if (!schedule?.id) return;
    await this.db.getRepository('employeeShifts').destroy({ filter: { notes: { $includes: `[Availability schedule ${schedule.id}]` } } });
  }

  async projectExistingSchedules() {
    const schedules = await this.db.getRepository('staffAvailabilitySchedules').find({ filter: { isWorking: true } });
    for (const schedule of schedules) await this.projectScheduleToEmployeeShifts(schedule);
  }

  async assertNoAppointmentsWouldBeInvalidated(staffId: number | string, start: Date, end: Date, ignoreAppointmentId?: number | string) {
    const appointments = await this.db.getRepository('appointments').find({
      filter: { $and: [{ staffId }, { status: { $notIn: UNAVAILABLE_STATUSES } }, { startTime: { $lt: end } }, { endTime: { $gt: start } }] },
      fields: ['id'], limit: 1,
    });
    if (appointments.some((item: any) => String(plain(item).id) !== String(ignoreAppointmentId || ''))) {
      throw new AvailabilityError('This change conflicts with an existing appointment. Reschedule the appointment first.');
    }
  }
}
