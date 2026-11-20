// BW-APPT-DATE v1 – Date field for the appointment create forms, next to Start Time.
//
// Bound to appointments.appointmentDate (dateOnly). The database trigger appointments_derive_date
// (scripts/migrations/20261003_derive_appointment_date.sql) still derives the stored date from startTime in the salon
// time zone, so the two can never disagree. This field is where staff pick the day; the Start Time field
// (scripts/ui/appointment-start-time.js, SEPARATE_DATE variant) offers the business-hours times and combines them with
// this date. Changing the date keeps the chosen time on the new day.
const START_FIELD = 'startTime';

const { React, dayjs } = ctx.libs;
const { DatePicker } = ctx.libs.antd;
const h = React.createElement;
const { useEffect, useState } = React;

const DEFAULT_TZ = 'America/Chicago';
// The business time zone comes from the business-hours settings the Start Time field on the same form already loads
// (window.__bwBusinessHoursPromise); this field makes no requests of its own. Default: America/Chicago.
const businessTimeZone = async () => {
  const pending = window.__bwBusinessHoursPromise;
  if (!pending) return null;
  const cfg = await pending;
  return (cfg && cfg.timeZone) || DEFAULT_TZ;
};
const ymdOf = (v) => {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  if (typeof v === 'object' && typeof v.format === 'function') return v.format('YYYY-MM-DD');
  return null;
};
// Calendar date of an instant in the business time zone.
const ymdIn = (value, tz) => {
  const ms = value && typeof value === 'object' && typeof value.valueOf === 'function' ? value.valueOf() : new Date(value).getTime();
  if (!Number.isFinite(ms)) return null;
  const p = {};
  new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(ms)).forEach((x) => { p[x.type] = x.value; });
  return p.year + '-' + p.month + '-' + p.day;
};

function AppointmentDate() {
  const [, rerender] = useState(0);
  const current = ymdOf(ctx.getValue ? ctx.getValue() : ctx.value);

  // A start time that arrives without a date (e.g. a calendar slot or a copied appointment) fills the date in.
  useEffect(() => {
    let off = false;
    const startedAt = Date.now();
    const sync = async () => {
      const start = ctx.formValues && ctx.formValues[START_FIELD];
      if (!start || ymdOf(ctx.getValue ? ctx.getValue() : ctx.value)) return;
      // Wait briefly for the business hours; after 3 s use the default zone.
      const tz = (await businessTimeZone()) || (Date.now() - startedAt > 3000 ? DEFAULT_TZ : null);
      if (!tz) return;
      const day = ymdIn(start, tz);
      if (!off && day) ctx.setValue && ctx.setValue(day);
    };
    sync();
    const timer = setInterval(() => { sync(); rerender((x) => x + 1); }, 400);
    return () => { off = true; clearInterval(timer); };
  }, []);

  return h(DatePicker, {
    value: current ? dayjs(current) : null,
    onChange: (d) => ctx.setValue && ctx.setValue(d ? d.format('YYYY-MM-DD') : null),
    format: 'ddd, MMM D, YYYY',
    inputReadOnly: true,
    allowClear: true,
    style: { width: '100%' },
    placeholder: 'Choose a date',
    'aria-label': 'Appointment date',
  });
}

ctx.render(h(AppointmentDate));
