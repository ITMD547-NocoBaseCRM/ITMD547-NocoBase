// Read-only integrity audit for the appointment, shift, and staff scheduling paths.
const { createClient, formatErrors } = require('./nocobase-api');

const data = (result, label) => {
  if (!result.ok) throw new Error(`${label} failed (${result.status}): ${formatErrors(result.json)}`);
  return result.json?.data || [];
};
const time = (value) => value ? new Date(value).getTime() : NaN;
const overlaps = (aStart, aEnd, bStart, bEnd) => time(aStart) < time(bEnd) && time(aEnd) > time(bStart);
const activeAppointment = (row) => !['cancelled', 'noShow'].includes(row.status);
const operationalAppointment = (row) => ['scheduled', 'confirmed', 'inProgress'].includes(row.status);
const workingShift = (row) => !['cancelled', 'onLeave'].includes(row.status);

async function main() {
  const client = await createClient();
  const [appointmentsResult, shiftsResult, staffResult, leavesResult, schedulesResult, overridesResult] = await Promise.all([
    client.request('appointments:list?paginate=false'),
    client.request('employeeShifts:list?paginate=false'),
    client.request('staff:list?paginate=false'),
    client.request('staffAvailabilityLeaves:list?paginate=false'),
    client.request('staffAvailabilitySchedules:list?paginate=false'),
    client.request('staffAvailabilityOverrides:list?paginate=false'),
  ]);
  const appointments = data(appointmentsResult, 'appointments');
  const shifts = data(shiftsResult, 'employee shifts');
  const staff = data(staffResult, 'staff');
  const leaves = data(leavesResult, 'staff leave');
  const schedules = data(schedulesResult, 'staff schedules');
  const overrides = data(overridesResult, 'staff overrides');
  const staffById = new Map(staff.map((row) => [String(row.id), row]));
  const issues = [];

  for (const appointment of appointments) {
    const label = `appointment ${appointment.id}`;
    if (!appointment.customerId) issues.push({ severity: 'blocker', code: 'appointment_missing_customer', label });
    if (!appointment.startTime || !appointment.endTime || !(time(appointment.endTime) > time(appointment.startTime))) {
      issues.push({ severity: 'blocker', code: 'appointment_invalid_time', label });
      continue;
    }
    if (appointment.staffId) {
      const member = staffById.get(String(appointment.staffId));
      if (!member) issues.push({ severity: 'blocker', code: 'appointment_missing_staff', label, staffId: appointment.staffId });
      else if (member.active === false) issues.push({ severity: 'warning', code: 'appointment_inactive_staff', label, staffId: appointment.staffId });
      if (operationalAppointment(appointment)) {
        const leave = leaves.find((row) => String(row.staffId) === String(appointment.staffId)
          && overlaps(appointment.startTime, appointment.endTime, row.startTime, row.endTime));
        if (leave) issues.push({ severity: 'blocker', code: 'appointment_overlaps_leave', label, leaveId: leave.id });
        const coveringShift = shifts.find((row) => String(row.staffId) === String(appointment.staffId)
          && workingShift(row) && time(row.startTime) <= time(appointment.startTime) && time(row.endTime) >= time(appointment.endTime));
        if (!coveringShift) issues.push({ severity: 'blocker', code: 'appointment_without_active_shift', label, staffId: appointment.staffId });
      }
    }
    const expectedColor = !appointment.staffId ? 'unassigned'
      : ['scheduled', 'confirmed', 'inProgress', 'completed', 'cancelled', 'noShow'].includes(appointment.status) ? appointment.status : 'scheduled';
    if (appointment.calendarColor !== expectedColor) issues.push({ severity: 'warning', code: 'stale_calendar_color', label, actual: appointment.calendarColor, expected: expectedColor });
    if (!appointment.calendarTitle || /^(N\/A|Untitle)$/i.test(appointment.calendarTitle)) issues.push({ severity: 'warning', code: 'missing_calendar_title', label });
  }

  const active = appointments.filter((row) => row.staffId && activeAppointment(row) && time(row.endTime) > time(row.startTime));
  for (let i = 0; i < active.length; i += 1) for (let j = i + 1; j < active.length; j += 1) {
    if (String(active[i].staffId) === String(active[j].staffId)
      && overlaps(active[i].startTime, active[i].endTime, active[j].startTime, active[j].endTime)) {
      issues.push({ severity: 'blocker', code: 'staff_double_booked', appointmentIds: [active[i].id, active[j].id], staffId: active[i].staffId });
    }
  }

  for (const shift of shifts) {
    const label = `shift ${shift.id}`;
    if (!shift.staffId || !staffById.has(String(shift.staffId))) issues.push({ severity: 'blocker', code: 'shift_missing_staff', label, staffId: shift.staffId });
    if (!shift.startTime || !shift.endTime || !(time(shift.endTime) > time(shift.startTime))) issues.push({ severity: 'blocker', code: 'shift_invalid_time', label });
    if (!shift.calendarTitle || /^(N\/A|Untitle)$/i.test(shift.calendarTitle)) issues.push({ severity: 'warning', code: 'missing_shift_title', label });
  }

  const activeShifts = shifts.filter((row) => row.staffId && workingShift(row) && time(row.endTime) > time(row.startTime));
  for (let i = 0; i < activeShifts.length; i += 1) for (let j = i + 1; j < activeShifts.length; j += 1) {
    if (String(activeShifts[i].staffId) === String(activeShifts[j].staffId)
      && overlaps(activeShifts[i].startTime, activeShifts[i].endTime, activeShifts[j].startTime, activeShifts[j].endTime)) {
      issues.push({ severity: 'warning', code: 'overlapping_staff_shifts', shiftIds: [activeShifts[i].id, activeShifts[j].id], staffId: activeShifts[i].staffId });
    }
  }

  const summary = {
    counts: { appointments: appointments.length, shifts: shifts.length, staff: staff.length, leaves: leaves.length, schedules: schedules.length, overrides: overrides.length },
    blockerCount: issues.filter((item) => item.severity === 'blocker').length,
    warningCount: issues.filter((item) => item.severity === 'warning').length,
    byCode: issues.reduce((result, item) => ({ ...result, [item.code]: (result[item.code] || 0) + 1 }), {}),
    issues,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (summary.blockerCount) process.exitCode = 2;
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
