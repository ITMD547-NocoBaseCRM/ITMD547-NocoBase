// Availability-aware staff selector for the New appointment form.
// Staff are eligible only when an active shift fully covers the appointment and no active appointment overlaps.
const { React } = ctx.libs;
const { Select, Alert, Spin } = ctx.libs.antd;
const { useEffect, useRef, useState } = React;
const h = React.createElement;

const valueId = (value) => value && typeof value === 'object' ? value.id : value;
const iso = (value) => {
  if (!value) return null;
  const date = value && typeof value.toDate === 'function' ? value.toDate() : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

function AvailableStaffSelect() {
  const [options, setOptions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('Choose an appointment start time.');
  const slotRef = useRef('');
  const timerRef = useRef();
  const requestRef = useRef(0);

  const current = ctx.getValue ? ctx.getValue() : ctx.value;
  const startValue = ctx.formValues?.startTime;
  const endValue = ctx.formValues?.endTime;

  const load = async () => {
    const requestId = ++requestRef.current;
    const start = iso(ctx.formValues?.startTime);
    if (!start) {
      setOptions([]); setLoading(false); setStatus('Choose an appointment start time.');
      return;
    }
    const providedEnd = iso(ctx.formValues?.endTime);
    const end = providedEnd || new Date(new Date(start).getTime() + 60 * 60000).toISOString();
    if (new Date(end) <= new Date(start)) {
      setOptions([]); setLoading(false); setStatus('End time must be after start time.');
      return;
    }
    setLoading(true); setStatus('Checking staff availability…');
    try {
      const response = await ctx.api.request({
        url: 'appointmentAvailability:availableStaff', method: 'post', data: { startTime: start, endTime: end },
      });
      if (requestId !== requestRef.current) return;
      const payload = response?.data?.data ?? response?.data ?? {};
      const available = (payload.staff || [])
        .map((item) => ({ value: item.id, label: [item.firstName, item.lastName].filter(Boolean).join(' ') || 'Unnamed staff member' }));
      setOptions(available);
      setStatus(available.length ? available.length + ' staff available' : 'No staff available. You can continue and book this appointment without assigning staff.');
      const selectedId = valueId(ctx.getValue ? ctx.getValue() : ctx.value);
      if (selectedId != null && !available.some((item) => String(item.value) === String(selectedId)) && ctx.setValue) ctx.setValue(null);
    } catch (error) {
      if (requestId !== requestRef.current) return;
      setOptions([]); setStatus('Staff availability is temporarily unavailable. You can continue and book without assigning staff.');
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  };

  useEffect(() => {
    const slot = String(startValue || '') + '|' + String(endValue || '');
    if (slot === slotRef.current) return;
    slotRef.current = slot;
    requestRef.current += 1; // Invalidate the previous slot before the debounce expires.
    clearTimeout(timerRef.current);
    setOptions([]);
    timerRef.current = setTimeout(load, 250);
    return () => clearTimeout(timerRef.current);
  }, [startValue, endValue]);

  useEffect(() => {
    const interval = setInterval(() => {
      const slot = String(ctx.formValues?.startTime || '') + '|' + String(ctx.formValues?.endTime || '');
      if (slot === slotRef.current) return;
      slotRef.current = slot;
      clearTimeout(timerRef.current);
      load();
    }, 600);
    return () => { clearInterval(interval); clearTimeout(timerRef.current); requestRef.current += 1; };
  }, []);

  const selected = valueId(current);
  return h('div', null,
    h(Select, {
      allowClear: true,
      showSearch: true,
      optionFilterProp: 'label',
      value: selected,
      options,
      loading,
      disabled: !iso(startValue),
      placeholder: loading ? 'Checking availability…' : options.length ? 'Select available staff' : 'No staff available',
      notFoundContent: loading ? h(Spin, { size: 'small' }) : 'No staff available',
      onChange: (id) => ctx.setValue && ctx.setValue(id == null ? null : { id }),
      style: { width: '100%' },
      'aria-label': 'Available staff',
    }),
    h(Alert, { type: options.length ? 'info' : 'warning', showIcon: true, message: status, style: { marginTop: 8, padding: '4px 10px' } }));
}

ctx.render(h(AvailableStaffSelect));
