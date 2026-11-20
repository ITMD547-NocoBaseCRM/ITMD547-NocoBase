// Runs before the native Edit Shift submit. The server-side availability guard stays authoritative.
const form = ctx.form;
if (!form) {
  ctx.message.error('The shift form is not ready. Please reopen it and try again.');
  ctx.exitAll();
}

const values = form.getFieldsValue(true);
const shiftId = values.id || ctx.view?.inputArgs?.filterByTk || await ctx.getVar('ctx.popup.record.id');
if (!shiftId) {
  ctx.message.error('Could not identify this shift. Please reopen it and try again.');
  ctx.exitAll();
}

const shiftResource = ctx.makeResource('SingleRecordResource');
shiftResource.setResourceName('employeeShifts');
shiftResource.setFilterByTk(shiftId);
await shiftResource.refresh();
const previous = shiftResource.getData();
if (!previous?.staffId) {
  ctx.message.error('Could not load the shift staff member. Please try again.');
  ctx.exitAll();
}

const staffIdOf = (value) => value && typeof value === 'object' ? value.id : value;
const nextStaffId = staffIdOf(values.staffId ?? values.staff) ?? previous.staffId;
const nextStatus = values.status ?? previous.status;
const nextStart = new Date(values.startTime ?? previous.startTime);
const nextEnd = new Date(values.endTime ?? previous.endTime);
const previousStart = new Date(previous.startTime);
const previousEnd = new Date(previous.endTime);
const sameStaff = String(nextStaffId) === String(previous.staffId);
const stillWorking = nextStatus !== 'onLeave' && nextStatus !== 'cancelled';

if (stillWorking && sameStaff && nextStart <= previousStart && nextEnd >= previousEnd) {
  return;
}

let appointments;
try {
  const response = await ctx.request({
    url: window.location.origin + '/api/appointmentAvailability:leaveConflicts',
    method: 'post',
    data: {
      staffId: previous.staffId,
      startTime: previous.startTime,
      endTime: previous.endTime,
    },
    skipNotify: true,
  });
  const data = response?.data?.data || response?.data || {};
  appointments = Array.isArray(data.appointments) ? data.appointments : [];
} catch (error) {
  ctx.message.error('Could not check the affected appointments. The shift was not saved.');
  ctx.exitAll();
}

const affected = appointments.filter((item) => {
  const start = new Date(item.startTime);
  const end = new Date(item.endTime);
  return !(stillWorking && sameStaff && nextStart <= start && nextEnd >= end);
});
if (!affected.length) {
  return;
}

const React = ctx.React;
const h = React.createElement;
const { Modal, Select, Alert, Typography } = ctx.antd;
const choices = Object.fromEntries(affected.map((item) => [String(item.id), '__unassigned__']));
const formatTime = (value) => new Date(value).toLocaleString([], {
  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
});

const decision = await new Promise((resolve) => {
  Modal.confirm({
    title: 'Assign appointments before changing this shift',
    width: 620,
    okText: 'Update appointments and save shift',
    cancelText: 'Keep editing',
    content: h('div', null,
      h(Alert, {
        type: 'warning',
        showIcon: true,
        message: 'This change affects assigned appointments.',
        description: 'Choose another available staff member or leave each appointment unassigned to assign later.',
        style: { marginBottom: 12 },
      }),
      ...affected.map((item) => h('div', {
        key: String(item.id),
        style: { marginBottom: 12 },
      },
      h(Typography.Text, { strong: true }, item.customerName || 'Customer'),
      h('div', { style: { margin: '4px 0 6px', color: '#667085' } },
        formatTime(item.startTime) + ' - ' + formatTime(item.endTime)),
      h(Select, {
        defaultValue: '__unassigned__',
        style: { width: '100%' },
        options: [
          ...(item.candidates || []).map((candidate) => ({
            value: candidate.id,
            label: candidate.name,
          })),
          { value: '__unassigned__', label: 'Assign later (leave unassigned)' },
        ],
        onChange: (value) => { choices[String(item.id)] = value; },
      })))),
    onOk: () => resolve(true),
    onCancel: () => resolve(false),
  });
});
if (!decision) {
  ctx.exitAll();
}

const selected = affected.map((item) => ({ ...item, staffChoice: choices[String(item.id)] }));
for (let left = 0; left < selected.length; left++) {
  for (let right = left + 1; right < selected.length; right++) {
    const a = selected[left];
    const b = selected[right];
    if (a.staffChoice === '__unassigned__' || String(a.staffChoice) !== String(b.staffChoice)) continue;
    if (new Date(a.startTime) < new Date(b.endTime) && new Date(b.startTime) < new Date(a.endTime)) {
      ctx.message.error('Two overlapping appointments cannot be assigned to the same staff member. Choose different staff or assign one later.');
      ctx.exitAll();
    }
  }
}

let updated = 0;
try {
  for (const item of selected) {
    const appointment = ctx.makeResource('SingleRecordResource');
    appointment.setResourceName('appointments');
    appointment.setFilterByTk(item.id);
    await appointment.save({ staffId: item.staffChoice === '__unassigned__' ? null : item.staffChoice }, { refresh: false });
    updated++;
  }
} catch (error) {
  ctx.message.error(updated
    ? 'Some appointments were updated, but the shift was not saved. Review assignments and try again.'
    : 'No appointments were updated. The shift was not saved. Please try again.');
  ctx.exitAll();
}
