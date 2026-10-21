// Availability-aware staff assignment in the appointment Details drawer.
const { React } = ctx.libs;
const { Alert, Select, message } = ctx.libs.antd;
const { useEffect, useState } = React;
const h = React.createElement;
const record = (await ctx.getVar('ctx.record')) || {};

const listRecords = async (collection, filter, fields) => {
  const resource = ctx.makeResource('MultiRecordResource');
  resource.setResourceName(collection);
  resource.setPageSize(500);
  if (filter) resource.setFilter(filter);
  if (fields && resource.setFields) resource.setFields(fields);
  await resource.refresh();
  return Array.isArray(resource.getData?.()) ? resource.getData() : [];
};
const nameOf = (item) => [item?.firstName, item?.lastName].filter(Boolean).join(' ') || 'Staff member';

async function availableOptions() {
  const start = new Date(record.startTime);
  if (Number.isNaN(start.getTime())) return [];
  const endDate = record.endTime ? new Date(record.endTime) : new Date(start.getTime() + 60 * 60000);
  const startIso = start.toISOString();
  const endIso = endDate.toISOString();
  const staffRows = await listRecords('staff', { active: { $eq: 'active' } }, ['id', 'firstName', 'lastName', 'active']);
  const checked = await Promise.all(staffRows.map(async (item) => {
    try {
      await ctx.api.request({ url: 'appointmentAvailability:check', method: 'post', data: { staffId: item.id, startTime: startIso, endTime: endIso, excludeAppointmentId: record.id } });
      return item;
    } catch (error) { return null; }
  }));
  const options = checked.filter(Boolean).map((item) => ({ value: item.id, label: nameOf(item) }));
  if (record.staff?.id && !options.some((item) => String(item.value) === String(record.staff.id))) {
    options.unshift({ value: record.staff.id, label: nameOf(record.staff) + ' (currently assigned)' });
  }
  return options;
}

function StaffAssignment() {
  const [options, setOptions] = useState([]);
  const [value, setValue] = useState(record.staffId ?? record.staff?.id ?? null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    availableOptions().then((items) => { if (active) { setOptions(items); setLoading(false); } })
      .catch(() => { if (active) { setError('Staff availability could not be checked.'); setLoading(false); } });
    return () => { active = false; };
  }, []);

  const assign = async (staffId) => {
    const previous = value;
    setValue(staffId); setSaving(true); setError('');
    try {
      const resource = ctx.makeResource('SingleRecordResource');
      resource.setResourceName('appointments');
      resource.setFilterByTk(record.id);
      await resource.save({ staffId }, { refresh: false });
      message.success(staffId ? 'Staff assigned successfully.' : 'Appointment is now unassigned.');
      try {
        const blockResource = ctx.blockModel?.resource;
        if (blockResource?.refresh) await blockResource.refresh();
      } catch (refreshError) { /* saved value is already shown locally */ }
    } catch (saveError) {
      setValue(previous);
      const detail = String(saveError?.message || '');
      setError(detail.includes('already has an appointment') ? 'That staff member was just booked for this time.'
        : detail.includes('outside the staff') || detail.includes('leave') ? 'That staff member is no longer available for this time.'
        : 'The staff assignment could not be saved. Please try again.');
    } finally { setSaving(false); }
  };

  return h('div', null,
    h(Select, {
      size: 'small', value, options, loading: loading || saving, disabled: loading || saving,
      allowClear: true, showSearch: true, optionFilterProp: 'label', onChange: assign,
      placeholder: loading ? 'Checking availability…' : options.length ? 'Assign available staff' : 'No staff available',
      notFoundContent: loading ? 'Checking availability…' : 'No staff available',
      style: { width: '100%', maxWidth: 260 }, 'aria-label': 'Assign appointment staff',
    }),
    !loading && !options.length && !value ? h('div', { style: { color: '#8c6a2b', fontSize: 12, marginTop: 5 } }, 'No staff are on shift and free for this time.') : null,
    error ? h(Alert, { type: 'error', showIcon: true, message: error, style: { marginTop: 7, padding: '4px 8px' } }) : null);
}

ctx.render(h(StaffAssignment));
