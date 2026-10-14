// Date of birth picker for the customer create and edit forms: three dropdowns (month, day, year) instead of a
// calendar, because a birthday is decades back and a calendar needs many clicks to reach it.
//
// Runs as a NocoBase editable JS field (JSEditableFieldModel) bound to customers.dateOfBirth. It reads the current
// value with ctx.getValue() and writes 'YYYY-MM-DD' back with ctx.setValue() once month, day and year are all chosen;
// clearing any dropdown clears the stored date. Days adapt to the month and year (30/31, leap February).
// The age is shown next to the dropdowns so a typo in the year is noticed at once.

const { React } = ctx.libs;
const { Select, Button } = ctx.libs.antd;
const { useState, useEffect } = React;
const h = React.createElement;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const THIS_YEAR = new Date().getFullYear();
const MIN_YEAR = THIS_YEAR - 110;
const YEARS = [];
for (let y = THIS_YEAR; y >= MIN_YEAR; y--) YEARS.push({ value: y, label: String(y) });
const daysIn = (year, month) => (year && month ? new Date(year, month, 0).getDate() : 31);
const pad = (n) => String(n).padStart(2, '0');

// Accepts 'YYYY-MM-DD', an ISO timestamp or nothing.
function parse(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
  return m ? { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) } : { year: undefined, month: undefined, day: undefined };
}
function age(year, month, day) {
  const today = new Date();
  let a = today.getFullYear() - year;
  if (today.getMonth() + 1 < month || (today.getMonth() + 1 === month && today.getDate() < day)) a -= 1;
  return a;
}

function BirthdayPicker() {
  const [v, setV] = useState(() => parse(ctx.getValue ? ctx.getValue() : ctx.value));
  // The authoring validator does not accept ctx.disabled / ctx.readOnly here; the forms always edit this field.
  const disabled = false;

  // Follow external changes (the form being reset or filled with a record).
  useEffect(() => {
    const current = ctx.getValue ? ctx.getValue() : ctx.value;
    const parsed = parse(current);
    if (parsed.year !== v.year || parsed.month !== v.month || parsed.day !== v.day) setV(parsed);
  }, [ctx.getValue ? ctx.getValue() : ctx.value]);

  const commit = (next) => {
    // Keep the day valid for the chosen month and year.
    if (next.day && next.day > daysIn(next.year, next.month)) next = { ...next, day: daysIn(next.year, next.month) };
    setV(next);
    if (!ctx.setValue) return;
    if (next.year && next.month && next.day) ctx.setValue(next.year + '-' + pad(next.month) + '-' + pad(next.day));
    else ctx.setValue(null);
  };
  const clear = () => commit({ year: undefined, month: undefined, day: undefined });

  const complete = v.year && v.month && v.day;
  const dayOptions = [];
  for (let d = 1; d <= daysIn(v.year, v.month); d++) dayOptions.push({ value: d, label: String(d) });
  const selectProps = { showSearch: true, optionFilterProp: 'label', allowClear: true, disabled, size: 'middle' };

  return h('div', { role: 'group', 'aria-label': 'Date of birth', style: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' } },
    h(Select, { ...selectProps, 'aria-label': 'Month', placeholder: 'Month', value: v.month, options: MONTHS.map((m, i) => ({ value: i + 1, label: m })), onChange: (month) => commit({ ...v, month }), style: { flex: '2 1 130px', minWidth: 120 } }),
    h(Select, { ...selectProps, 'aria-label': 'Day', placeholder: 'Day', value: v.day, options: dayOptions, onChange: (day) => commit({ ...v, day }), style: { flex: '1 1 80px', minWidth: 72 } }),
    h(Select, { ...selectProps, 'aria-label': 'Year', placeholder: 'Year', value: v.year, options: YEARS, onChange: (year) => commit({ ...v, year }), style: { flex: '1 1 100px', minWidth: 90 } }),
    h('span', { 'aria-live': 'polite', style: { fontSize: 12, color: '#6b7280', whiteSpace: 'nowrap' } },
      complete ? 'Age ' + age(v.year, v.month, v.day) : (v.year || v.month || v.day) ? 'Choose month, day and year' : ''),
    !disabled && (v.year || v.month || v.day) ? h(Button, { type: 'link', size: 'small', onClick: clear, style: { padding: 0 } }, 'Clear') : null);
}

ctx.render(h(BirthdayPicker));
