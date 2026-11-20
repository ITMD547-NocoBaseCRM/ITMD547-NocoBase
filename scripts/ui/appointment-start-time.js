// BW-APPT-HOURS v3 – Start Time for the appointment create and edit forms.
// A list of start times inside business hours (System settings → options.bwBusinessHours, default 7:00 AM – 7:00 PM,
// America/Chicago, 15-minute steps). Times can't be typed, so an out-of-hours start can't be entered. Appointments
// already saved outside business hours keep their time until someone changes it.
//
// v3: the date can live in its own "Date" field (scripts/ui/appointment-date.js, bound to appointments.appointmentDate,
// which the database also derives from startTime). With SEPARATE_DATE the field shows only the time list and combines
// it with that date; when the date changes, the chosen time moves to the new date. Without SEPARATE_DATE it renders the
// date picker and the time list together, exactly like v2. The variant is filled in by scripts/apply-appointment-date.js.
const SEPARATE_DATE = /*SEPARATE_DATE*/true;
const DATE_FIELD = 'appointmentDate';

const { React, dayjs } = ctx.libs;
const { DatePicker, Select, Typography, Alert } = ctx.libs.antd;
const h = React.createElement;
const { useEffect, useRef, useState } = React;

const DEFAULTS = { open: '07:00', close: '19:00', timeZone: 'America/Chicago', appointmentStepMinutes: 15 };
const loadConfig = () => {
  if (!window.__bwBusinessHoursPromise) {
    window.__bwBusinessHoursPromise = ctx.api.request({ url: 'systemSettings:get' })
      .then((res) => Object.assign({}, DEFAULTS, (res && res.data && res.data.data && res.data.data.options && res.data.data.options.bwBusinessHours) || {}))
      .catch(() => DEFAULTS);
  }
  return window.__bwBusinessHoursPromise;
};
const hm = (s) => { const p = String(s).split(':'); return Number(p[0]) * 60 + Number(p[1] || 0); };
const label = (m) => { const hh = Math.floor(m / 60); const mm = Math.round(m % 60); return ((hh % 12) || 12) + ':' + String(mm).padStart(2, '0') + ' ' + (hh < 12 ? 'AM' : 'PM'); };
const asMs = (v) => {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'object' && typeof v.toDate === 'function') return v.valueOf();
  const ms = new Date(v).getTime();
  return Number.isNaN(ms) ? null : ms;
};
const partsIn = (ms, tz) => {
  const p = {};
  new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(ms)).forEach((x) => { p[x.type] = x.value; });
  return { ymd: p.year + '-' + p.month + '-' + p.day, min: (Number(p.hour) % 24) * 60 + Number(p.minute) + Number(p.second) / 60 };
};
// Wall-clock date + minutes in the business time zone -> UTC instant (iterates over the zone offset, DST-safe).
const toInstant = (ymd, min, tz) => {
  const [y, m, d] = ymd.split('-').map(Number);
  const want = Date.UTC(y, m - 1, d, Math.floor(min / 60), min % 60);
  let guess = want;
  for (let i = 0; i < 3; i += 1) {
    const p = partsIn(guess, tz);
    const [py, pm, pd] = p.ymd.split('-').map(Number);
    const seen = Date.UTC(py, pm - 1, pd, Math.floor(p.min / 60), Math.round(p.min % 60));
    if (seen === want) break;
    guess += want - seen;
  }
  return guess;
};
// The Date field's value: 'YYYY-MM-DD' (dateOnly) or a dayjs/Date while the form is being edited.
const ymdOf = (v) => {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  if (typeof v === 'object' && typeof v.format === 'function') return v.format('YYYY-MM-DD');
  return null;
};
const formDate = () => (SEPARATE_DATE ? ymdOf(ctx.formValues && ctx.formValues[DATE_FIELD]) : null);

function AppointmentStartTime() {
  const [cfg, setCfg] = useState(null);
  const [notice, setNotice] = useState('');
  const [pendingDate, setPendingDate] = useState(null);
  const [, rerender] = useState(0);
  const original = useRef(asMs(ctx.getValue ? ctx.getValue() : ctx.value));
  const isEdit = !!((ctx.record && ctx.record.id) || (ctx.formValues && ctx.formValues.id));
  useEffect(() => { let off = false; loadConfig().then((c) => { if (!off) setCfg(c); }); return () => { off = true; }; }, []);
  // Re-render when this field's value or the separate Date field changes (other fields can set them).
  useEffect(() => {
    let last = '';
    const timer = setInterval(() => {
      const sig = String(asMs(ctx.getValue ? ctx.getValue() : ctx.value)) + '|' + String(formDate());
      if (sig !== last) { last = sig; rerender((x) => x + 1); }
    }, 250);
    return () => clearInterval(timer);
  }, []);

  const value = asMs(ctx.getValue ? ctx.getValue() : ctx.value);
  const tz = (cfg && cfg.timeZone) || DEFAULTS.timeZone;
  const OPEN = hm((cfg && cfg.open) || DEFAULTS.open);
  const CLOSE = hm((cfg && cfg.close) || DEFAULTS.close);
  const STEP = Number((cfg && cfg.appointmentStepMinutes) || DEFAULTS.appointmentStepMinutes) || 15;
  const own = value !== null ? partsIn(value, tz) : null;
  const dateField = formDate();
  const ymd = SEPARATE_DATE ? dateField : pendingDate || (own && own.ymd) || null;
  const allowed = (min) => min >= OPEN && min <= CLOSE - STEP; // a start leaves room for at least one step
  const valid = own === null || allowed(own.min);
  const historical = isEdit && value !== null && value === original.current && !!own && !allowed(own.min);

  // Separate Date field: keep the start time on the chosen date. A new date keeps the chosen time of day;
  // clearing the date clears the start time. Runs only once the business hours are known (correct time zone).
  useEffect(() => {
    if (!SEPARATE_DATE || !cfg) return;
    if (!dateField) {
      if (own && !historical) ctx.setValue && ctx.setValue(null);
      return;
    }
    if (own && own.ymd !== dateField) {
      if (valid || historical) ctx.setValue && ctx.setValue(dayjs(toInstant(dateField, Math.round(own.min), tz)));
      else ctx.setValue && ctx.setValue(null); // the time must be picked again for the new date
    }
  }, [cfg, dateField, own && own.ymd]);

  const options = [];
  for (let m = OPEN; m <= CLOSE - STEP; m += STEP) options.push({ value: m, label: label(m) });
  let selected = null;
  if (own) {
    const exact = Math.round(own.min);
    if (valid && !options.some((o) => o.value === exact)) options.push({ value: exact, label: label(exact) });
    options.sort((a, b) => a.value - b.value);
    if (valid) selected = exact;
    else if (historical) { options.unshift({ value: '__saved', label: label(exact) + ' (saved, outside business hours)', disabled: true }); selected = '__saved'; }
  }

  const onDate = (d) => {
    setNotice('');
    if (!d) { setPendingDate(null); ctx.setValue && ctx.setValue(null); return; }
    const day = d.format('YYYY-MM-DD');
    setPendingDate(day);
    if (own && valid) ctx.setValue && ctx.setValue(dayjs(toInstant(day, Math.round(own.min), tz)));
    else if (own) ctx.setValue && ctx.setValue(null); // the time must be picked again for the new date
  };
  const onTime = (m) => {
    if (!ymd) { setNotice('Choose the appointment date first.'); return; }
    setNotice('');
    ctx.setValue && ctx.setValue(dayjs(toInstant(ymd, m, tz)));
  };

  const timeSelect = h(Select, {
    value: selected,
    options,
    onChange: onTime,
    disabled: !cfg || (SEPARATE_DATE && !ymd),
    placeholder: SEPARATE_DATE && !ymd ? 'Choose a date first' : 'Start time',
    virtual: false,
    listHeight: 288,
    style: SEPARATE_DATE ? { width: '100%' } : { flex: '1 1 140px', minWidth: 0 },
    status: own && !valid && !historical ? 'error' : undefined,
    'aria-label': 'Appointment start time',
  });
  const children = SEPARATE_DATE
    ? [h('div', { key: 'row' }, timeSelect)]
    : [
        h('div', { key: 'row', style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
          h(DatePicker, {
            value: ymd ? dayjs(ymd) : null,
            onChange: onDate,
            format: 'ddd, MMM D, YYYY',
            inputReadOnly: true,
            style: { flex: '1 1 170px', minWidth: 0 },
            placeholder: 'Date',
            'aria-label': 'Appointment date',
          }),
          timeSelect),
      ];
  children.push(h(Typography.Text, { key: 'hint', type: 'secondary', style: { fontSize: 12 } }, 'Appointments run between ' + label(OPEN) + ' and ' + label(CLOSE) + '.'));
  if (notice) children.push(h(Typography.Text, { key: 'notice', type: 'danger', style: { fontSize: 12 } }, notice));
  else if (own && !valid && !historical) {
    children.push(h(Typography.Text, { key: 'bad', type: 'danger', style: { fontSize: 12 } },
      (own.min < OPEN ? 'Appointments cannot start before ' + label(OPEN) : 'Appointments must start before ' + label(CLOSE)) + '. Choose a time from the list.'));
  }
  if (historical) {
    children.push(h(Alert, { key: 'hist', type: 'warning', showIcon: true, style: { marginTop: 4 },
      message: 'This appointment was booked outside business hours (' + label(OPEN) + ' – ' + label(CLOSE) + ').',
      description: 'Its time stays as saved. If you change the start or end time, the new time must be within business hours.' }));
  }
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 } }, children);
}

ctx.render(h(AppointmentStartTime));
