// Duration-aware End Time field for appointment create/edit forms.
// Service duration is the helpful default; users can always override the resulting end time.
const { React, dayjs } = ctx.libs;
const { Alert, Button, DatePicker, Space, Typography } = ctx.libs.antd;
const { useEffect, useRef, useState } = React;
const h = React.createElement;

const asDate = (value) => {
  if (!value) return null;
  const date = value && typeof value.toDate === 'function' ? value.toDate() : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};
const linesOf = (value) => {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.data)) return value.data;
  return [];
};
const serviceIdOf = (line) => line?.serviceId?.id ?? line?.serviceId ?? line?.service?.id;
const durationOf = (line, serviceDurations = {}) => {
  const value = line?.durationAtBooking ?? line?.service?.durationMinutes ?? line?.service?.duration ?? serviceDurations[String(serviceIdOf(line))];
  const minutes = Number(value);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : 0;
};
const serviceKey = (lines, serviceDurations) => lines.map((line, index) => [
  line?.id ?? serviceIdOf(line) ?? index,
  durationOf(line, serviceDurations),
].join(':')).join('|');
const loadServiceDurations = async (ids) => {
  if (!ids.length) return {};
  const resource = ctx.makeResource('MultiRecordResource');
  resource.setResourceName('services');
  resource.setPageSize(500);
  resource.setFilter({ id: { $in: ids } });
  if (resource.setFields) resource.setFields(['id', 'durationMinutes']);
  await resource.refresh();
  const rows = Array.isArray(resource.getData?.()) ? resource.getData() : [];
  return Object.fromEntries(rows.map((item) => [String(item.id), Number(item.durationMinutes) || 0]));
};
const setEndValue = (value) => ctx.setValue && ctx.setValue(value ? dayjs(value) : null);

function DurationAwareEndTime() {
  const startValue = ctx.formValues?.startTime;
  const servicesValue = ctx.formValues?.appointmentServices;
  const currentValue = ctx.getValue ? ctx.getValue() : ctx.value;
  const [notice, setNotice] = useState('');
  const [manual, setManual] = useState(false);
  const signatureRef = useRef('');
  const appliedRef = useRef('');
  const durationsRef = useRef({});
  const requestRef = useRef(0);
  const timerRef = useRef();

  const reconcile = async () => {
    const requestId = ++requestRef.current;
    const start = asDate(ctx.formValues?.startTime);
    const lines = linesOf(ctx.formValues?.appointmentServices);
    const missingIds = [...new Set(lines.map(serviceIdOf).filter((id) => id != null && !durationOf(lines.find((line) => String(serviceIdOf(line)) === String(id)), durationsRef.current)))];
    if (missingIds.length) {
      try { durationsRef.current = { ...durationsRef.current, ...(await loadServiceDurations(missingIds)) }; } catch (error) { /* visible duration fields can still drive the total */ }
    }
    if (requestId !== requestRef.current) return;
    const minutes = lines.reduce((sum, line) => sum + durationOf(line, durationsRef.current), 0);
    const key = serviceKey(lines, durationsRef.current);
    const signature = `${start?.toISOString() || ''}|${key}`;
    if (signature === signatureRef.current) return;
    const servicesChanged = key !== signatureRef.current.split('|').slice(1).join('|');
    signatureRef.current = signature;
    if (!start || !minutes) {
      setNotice('');
      if (servicesChanged) setManual(false);
      return;
    }
    if (servicesChanged) setManual(false);
    const expected = new Date(start.getTime() + minutes * 60000);
    const current = asDate(ctx.getValue ? ctx.getValue() : ctx.value);
    if (!manual || servicesChanged || !current) {
      appliedRef.current = expected.toISOString();
      setEndValue(expected);
      setNotice(`Selected services need ${minutes} minutes. The end time was adjusted automatically; you can override it below.`);
    } else if (Math.round((current.getTime() - start.getTime()) / 60000) !== minutes) {
      const chosen = Math.round((current.getTime() - start.getTime()) / 60000);
      setNotice(`Selected services need ${minutes} minutes, but the appointment is set to ${chosen} minutes. Your manual time will be used.`);
    } else setNotice('');
  };

  useEffect(() => {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(reconcile, 200);
    return () => clearTimeout(timerRef.current);
  }, [startValue, servicesValue]);

  useEffect(() => {
    const interval = setInterval(reconcile, 500);
    reconcile();
    return () => { clearInterval(interval); clearTimeout(timerRef.current); };
  }, [manual]);

  const onChange = (value) => {
    const iso = value ? value.toISOString() : '';
    const automatic = iso && iso === appliedRef.current;
    if (!automatic) setManual(true);
    setEndValue(value);
    setTimeout(reconcile, 0);
  };
  const useServiceDuration = () => {
    setManual(false);
    signatureRef.current = '';
    setTimeout(reconcile, 0);
  };

  return h('div', null,
    h(DatePicker, {
      value: currentValue ? dayjs(currentValue) : null,
      onChange,
      showTime: { format: 'h:mm A' },
      format: 'YYYY-MM-DD h:mm A',
      style: { width: '100%' },
      placeholder: 'Select end time',
      'aria-label': 'Appointment end time',
    }),
    notice ? h(Alert, {
      type: manual ? 'warning' : 'info',
      showIcon: true,
      message: notice,
      style: { marginTop: 8, padding: '6px 10px' },
      action: manual ? h(Button, { size: 'small', type: 'link', onClick: useServiceDuration }, 'Use service duration') : null,
    }) : h(Typography.Text, { type: 'secondary', style: { display: 'block', marginTop: 5, fontSize: 12 } }, 'End time follows the total service duration and can be changed manually.'));
}

ctx.render(h(DurationAwareEndTime));
