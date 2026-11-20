// Apply the coordinated scheduling screens only after the shared plugin API is available.
// --check verifies live code without writes. --repair-uncovered safely unassigns uncovered
// scheduled/checked-in/in-progress appointments; no appointment records are deleted.
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createClient, formatErrors } = require('./nocobase-api');

async function main() {
  const check = process.argv.includes('--check');
  const client = await createClient();
  const startTime = new Date().toISOString();
  const endTime = new Date(Date.now() + 3600000).toISOString();
  const probe = await client.request('appointmentAvailability:availableStaff', { method: 'POST', body: { startTime, endTime } });
  if (!probe.ok) throw new Error(`The shared availability plugin is not ready (${probe.status}): ${formatErrors(probe.json)}. Restart NocoBase before applying the screens.`);
  const repaired = [];
  if (process.argv.includes('--repair-uncovered')) {
    const listed = await client.request('appointments:list?paginate=false&fields=id,staffId,status,startTime,endTime');
    if (!listed.ok) throw new Error(formatErrors(listed.json));
    for (const appointment of (listed.json?.data || []).filter((row) => row.staffId && ['scheduled', 'confirmed', 'inProgress'].includes(row.status))) {
      const result = await client.request('appointmentAvailability:check', { method: 'POST', body: { staffId: appointment.staffId, startTime: appointment.startTime, endTime: appointment.endTime, excludeAppointmentId: appointment.id } });
      if (result.ok) continue;
      const reason = formatErrors(result.json);
      if (result.status !== 409 || !/outside the staff|overlaps staff leave|inactive or no longer exists/.test(reason)) throw new Error(`Cannot safely repair appointment ${appointment.id}: ${reason}`);
      if (!check) {
        const updated = await client.request(`appointments:update?filterByTk=${encodeURIComponent(appointment.id)}`, { method: 'POST', body: { staffId: null } });
        if (!updated.ok) throw new Error(`Unassign appointment ${appointment.id}: ${formatErrors(updated.json)}`);
      }
      repaired.push({ id: appointment.id, previousStaffId: appointment.staffId, reason, dryRun: check || undefined });
    }
  }
  for (const file of ['apply-appointment-available-staff.js', 'apply-appointment-details-staff.js', 'apply-salon-dashboard.js', 'apply-shift-calendar-hide-leave.js']) {
    const result = spawnSync(process.execPath, [path.join(__dirname, file), ...(check ? ['--check'] : [])], { cwd: path.resolve(__dirname, '..'), stdio: 'inherit' });
    if (result.status !== 0) throw new Error(`${file} failed (${result.status})`);
  }
  console.log(JSON.stringify({ status: 'ok', mode: check ? 'check' : 'apply', repaired }, null, 2));
}
main().catch((error) => {
  console.error(error.message || error.errors?.map((item) => item.code).join(', ') || String(error));
  process.exitCode = 1;
});
