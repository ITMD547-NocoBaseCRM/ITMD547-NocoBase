// Responsive daily operations dashboard for salon owners.
const { React } = ctx.libs;
const { Alert, Button, Card, Col, Empty, Modal, Row, Select, Skeleton, Space, Tag, Typography, message } = ctx.libs.antd;
const { useEffect, useState } = React;
const h = React.createElement;

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const clock = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });
const dayLabel = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
const activeStatuses = new Set(['scheduled', 'confirmed', 'inProgress', 'completed']);
const statusColor = { scheduled: 'blue', confirmed: 'cyan', inProgress: 'purple', completed: 'green', cancelled: 'default', noShow: 'orange' };

const recordsOf = (response) => {
  const value = response?.data?.data ?? response?.data ?? [];
  return Array.isArray(value) ? value : value?.data || [];
};
const personName = (record, fallback) => record ? [record.firstName, record.lastName].filter(Boolean).join(' ') || fallback : fallback;
const valuesOf = (value) => Array.isArray(value) ? value.filter(Boolean) : value ? [value] : [];
const sensitivityLabels = (customer) => {
  if (!customer) return [];
  const values = valuesOf(customer.skinSensitivities).map(String);
  if (customer.skinSensitivitiesOther && (values.includes('other') || values.includes('Other'))) values.push(customer.skinSensitivitiesOther);
  else if (customer.skinSensitivitiesOther) values.push(customer.skinSensitivitiesOther);
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
};
const serviceLines = (appointment) => Array.isArray(appointment.appointmentServices) ? appointment.appointmentServices : [];
const serviceNames = (appointment) => serviceLines(appointment).map((line) => line?.service?.name).filter(Boolean);
const earning = (appointment) => serviceLines(appointment).reduce((sum, line) => sum + Number(line?.priceAtBooking ?? line?.service?.price ?? 0), 0);
const loadAppointments = async (filter) => {
  const resource = ctx.makeResource('MultiRecordResource');
  resource.setResourceName('appointments');
  resource.setPageSize(500);
  resource.setFilter(filter);
  if (resource.setSort) resource.setSort(['startTime']);
  if (resource.setFields) resource.setFields([
    'id', 'status', 'category', 'startTime', 'endTime', 'staffId',
    'customer.firstName', 'customer.lastName', 'customer.skinSensitivities', 'customer.skinSensitivitiesOther',
    'staff.firstName', 'staff.lastName',
    'appointmentServices.priceAtBooking', 'appointmentServices.service.name', 'appointmentServices.service.price',
  ]);
  await resource.refresh();
  return Array.isArray(resource.getData?.()) ? resource.getData() : [];
};
const availableStaffFor = async (appointment) => {
  const start = new Date(appointment.startTime).toISOString();
  const endValue = appointment.endTime || new Date(new Date(start).getTime() + 60 * 60000);
  const end = new Date(endValue).toISOString();
  const response = await ctx.api.request({ url: 'appointmentAvailability:availableStaff', method: 'post', data: { startTime: start, endTime: end, excludeAppointmentId: appointment.id } });
  const payload = response?.data?.data ?? response?.data ?? {};
  return (payload.staff || []).map((item) => ({ value: item.id, label: personName(item, 'Unnamed staff member') }));
};
const assignAppointment = async (appointmentId, staffId) => {
  const resource = ctx.makeResource('SingleRecordResource');
  resource.setResourceName('appointments');
  resource.setFilterByTk(appointmentId);
  await resource.save({ staffId }, { refresh: false });
};

function Metric({ label, value, hint, tone }) {
  return h(Card, { size: 'small', style: { height: '100%', borderRadius: 14, borderColor: tone || '#eadfd8' } },
    h(Typography.Text, { type: 'secondary', style: { fontSize: 12 } }, label),
    h('div', { style: { fontSize: 28, lineHeight: 1.2, fontWeight: 700, marginTop: 6 } }, value),
    h(Typography.Text, { type: 'secondary', style: { fontSize: 12 } }, hint));
}

function AppointmentCard({ item, onAssign }) {
  const sensitivities = sensitivityLabels(item.customer);
  const services = serviceNames(item);
  return h('div', { style: { display: 'grid', gridTemplateColumns: '72px minmax(0,1fr) auto', gap: 12, alignItems: 'start', padding: '14px 0', borderBottom: '1px solid #f0e8e3' } },
    h('div', { style: { fontWeight: 700, color: '#6f3f2e' } }, clock.format(new Date(item.startTime))),
    h('div', { style: { minWidth: 0 } },
      h('div', { style: { fontWeight: 650 } }, personName(item.customer, 'Customer')),
      h('div', { style: { color: '#6b7280', fontSize: 13, marginTop: 2 } }, services.join(', ') || item.category || 'Appointment'),
      item.staffId || item.staff
        ? h('div', { style: { color: '#6b7280', fontSize: 12, marginTop: 3 } }, personName(item.staff, 'Staff assigned'))
        : h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 7 } },
          h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 5, color: '#9a5a13', fontSize: 12, fontWeight: 600 } },
            h('span', { style: { width: 6, height: 6, borderRadius: '50%', background: '#d9822b', flex: '0 0 auto' } }),
            'Unassigned'),
          h(Button, {
            size: 'small',
            onClick: () => onAssign(item),
            style: { height: 28, padding: '0 10px', borderRadius: 7, color: '#7a4533', borderColor: '#cda896', background: '#fff', fontWeight: 600 },
          }, '+ Assign staff')),
      sensitivities.length ? h(Space, { size: [4, 4], wrap: true, style: { marginTop: 7 } }, sensitivities.map((label) => h(Tag, { color: 'volcano', key: label, style: { margin: 0 } }, label))) : null),
    h('div', { style: { textAlign: 'right' } },
      h(Tag, { color: statusColor[item.status] || 'default', style: { margin: 0 } }, item.status || 'Unknown'),
      h('div', { style: { marginTop: 7, fontWeight: 650 } }, money.format(earning(item)))));
}

function Dashboard() {
  const [state, setState] = useState({ loading: true, rows: [], error: '' });
  const [assignment, setAssignment] = useState({ open: false, item: null, options: [], staffId: null, loading: false, saving: false, error: '' });
  const load = async () => {
    setState((old) => ({ ...old, loading: true, error: '' }));
    try {
      const now = new Date();
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      const rows = await loadAppointments({ $and: [{ startTime: { $gte: start.toISOString() } }, { startTime: { $lt: end.toISOString() } }] });
      setState({ loading: false, rows, error: '' });
    } catch (error) {
      setState({ loading: false, rows: [], error: 'Today’s dashboard could not be loaded. Please refresh and try again.' });
    }
  };
  useEffect(() => { load(); }, []);

  const openAssignment = async (item) => {
    setAssignment({ open: true, item, options: [], staffId: null, loading: true, saving: false, error: '' });
    try {
      const options = await availableStaffFor(item);
      setAssignment((old) => ({ ...old, options, loading: false }));
    } catch (error) {
      setAssignment((old) => ({ ...old, loading: false, error: 'Available staff could not be checked. Please try again.' }));
    }
  };
  const saveAssignment = async () => {
    if (!assignment.staffId || !assignment.item) return;
    setAssignment((old) => ({ ...old, saving: true, error: '' }));
    try {
      await assignAppointment(assignment.item.id, assignment.staffId);
      message.success('Staff assigned successfully.');
      setAssignment({ open: false, item: null, options: [], staffId: null, loading: false, saving: false, error: '' });
      await load();
    } catch (error) {
      const detail = String(error?.message || '');
      const friendly = detail.includes('already has an appointment') ? 'That staff member was just booked for this time. Choose another staff member.'
        : detail.includes('outside the staff') || detail.includes('leave') ? 'That staff member is no longer available for this appointment.'
        : 'The appointment could not be assigned. Please refresh and try again.';
      setAssignment((old) => ({ ...old, saving: false, error: friendly }));
    }
  };

  const operational = state.rows.filter((item) => activeStatuses.has(item.status));
  const revenue = operational.reduce((sum, item) => sum + earning(item), 0);
  const currentRevenue = state.rows.filter((item) => item.status === 'completed').reduce((sum, item) => sum + earning(item), 0);
  const flagged = operational.filter((item) => sensitivityLabels(item.customer).length > 0);
  const unassigned = operational.filter((item) => !item.staffId && !item.staff).length;

  return h('div', { style: { width: '100%', maxWidth: 1180, margin: '0 auto', padding: '4px 2px 24px' } },
    h('div', { style: { display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', marginBottom: 16 } },
      h('div', null,
        h(Typography.Title, { level: 2, style: { margin: 0, fontSize: 'clamp(22px, 5vw, 30px)' } }, 'Today at a glance'),
        h(Typography.Text, { type: 'secondary' }, dayLabel.format(new Date()))),
      h(Button, { onClick: load, loading: state.loading }, 'Refresh')),
    state.error ? h(Alert, { type: 'error', showIcon: true, message: state.error, style: { marginBottom: 16 } }) : null,
    h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(145px, 1fr))', gap: 12, marginBottom: 16 } },
      h(Metric, { label: 'Appointments', value: operational.length, hint: state.rows.length === operational.length ? 'scheduled today' : `${state.rows.length - operational.length} cancelled / no-show` }),
      h(Metric, { label: 'Expected earnings', value: money.format(revenue), hint: 'from active bookings', tone: '#cde9d5' }),
      h(Metric, { label: 'Current earnings', value: money.format(currentRevenue), hint: 'from appointments completed today', tone: '#b8ddf5' }),
      h(Metric, { label: 'Safety flags', value: flagged.length, hint: flagged.length ? 'review before service' : 'no sensitivities flagged', tone: flagged.length ? '#ffc9bb' : '#cde9d5' }),
      h(Metric, { label: 'Unassigned', value: unassigned, hint: unassigned ? 'needs staff attention' : 'all appointments covered', tone: unassigned ? '#ffe0a3' : '#cde9d5' })),
    state.loading ? h(Card, { style: { borderRadius: 14 } }, h(Skeleton, { active: true, paragraph: { rows: 8 } })) :
      h(Row, { gutter: [16, 16] },
        h(Col, { xs: 24, lg: 16 }, h(Card, { title: `Today’s schedule (${operational.length})`, style: { borderRadius: 14 } },
          operational.length ? operational.map((item) => h(AppointmentCard, { key: item.id, item, onAssign: openAssignment })) : h(Empty, { description: 'No active appointments today' }))),
        h(Col, { xs: 24, lg: 8 }, h(Card, { title: 'Client safety', style: { borderRadius: 14 } },
          flagged.length ? flagged.map((item) => h('div', { key: item.id, style: { padding: '10px 0', borderBottom: '1px solid #f0e8e3' } },
            h('div', { style: { fontWeight: 650 } }, personName(item.customer, 'Customer')),
            h('div', { style: { color: '#6b7280', fontSize: 12, margin: '2px 0 7px' } }, `${clock.format(new Date(item.startTime))} · ${serviceNames(item).join(', ') || item.category || 'Appointment'}`),
            h(Space, { size: [4, 4], wrap: true }, sensitivityLabels(item.customer).map((label) => h(Tag, { color: 'volcano', key: label, style: { margin: 0 } }, label)))))
            : h(Empty, { image: Empty.PRESENTED_IMAGE_SIMPLE, description: 'No sensitivities flagged today' })))),
    h(Modal, {
      title: 'Assign staff',
      open: assignment.open,
      onCancel: () => !assignment.saving && setAssignment((old) => ({ ...old, open: false })),
      onOk: saveAssignment,
      okText: 'Assign',
      okButtonProps: { disabled: !assignment.staffId || assignment.loading || !assignment.options.length },
      confirmLoading: assignment.saving,
      destroyOnClose: true,
    },
      assignment.item ? h(Typography.Paragraph, { type: 'secondary' }, `${personName(assignment.item.customer, 'Customer')} · ${clock.format(new Date(assignment.item.startTime))}`) : null,
      assignment.error ? h(Alert, { type: 'error', showIcon: true, message: assignment.error, style: { marginBottom: 12 } }) : null,
      h(Select, {
        value: assignment.staffId,
        onChange: (staffId) => setAssignment((old) => ({ ...old, staffId })),
        options: assignment.options,
        loading: assignment.loading,
        showSearch: true,
        optionFilterProp: 'label',
        placeholder: assignment.loading ? 'Checking availability…' : assignment.options.length ? 'Select available staff' : 'No staff available',
        notFoundContent: assignment.loading ? 'Checking availability…' : 'No staff available for this time',
        style: { width: '100%' },
      }),
      !assignment.loading && !assignment.options.length && !assignment.error ? h(Alert, { type: 'warning', showIcon: true, message: 'No staff are on shift and free for this appointment.', style: { marginTop: 12 } }) : null));
}

ctx.render(h(Dashboard));
