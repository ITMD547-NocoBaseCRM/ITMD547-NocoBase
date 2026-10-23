// Repairs projected availability shifts that carry an active leave marker but are not status=onLeave.
// Safe to repeat; only plugin-generated shifts linked to an existing leave record are changed.
const { createClient, formatErrors } = require('./nocobase-api');

const fail = (what, result) => new Error(`${what} failed (${result.status}):\n${formatErrors(result.json)}`);

async function main() {
  const check = process.argv.includes('--check');
  const client = await createClient();
  const [shiftResult, leaveResult] = await Promise.all([
    client.request('employeeShifts:list?paginate=false&fields=id,status,calendarTitle,notes'),
    client.request('staffAvailabilityLeaves:list?paginate=false&fields=id'),
  ]);
  if (!shiftResult.ok) throw fail('list employee shifts', shiftResult);
  if (!leaveResult.ok) throw fail('list staff leave', leaveResult);
  const activeLeaveIds = new Set((leaveResult.json?.data || []).map((row) => String(row.id)));
  const affected = (shiftResult.json?.data || []).filter((shift) => {
    const ids = [...String(shift.notes || '').matchAll(/\[Availability leave ([^\]]+)\]/g)].map((match) => match[1]);
    return shift.status !== 'onLeave' && ids.some((id) => activeLeaveIds.has(String(id)));
  });
  if (!check) {
    for (const shift of affected) {
      const updated = await client.request(`employeeShifts:update?filterByTk=${encodeURIComponent(shift.id)}`, {
        method: 'POST', body: { status: 'onLeave' },
      });
      if (!updated.ok) throw fail(`update employee shift ${shift.id}`, updated);
    }
  }
  console.log(JSON.stringify({ status: 'ok', mode: check ? 'check' : 'apply', affected: affected.map((row) => row.id) }, null, 2));
}

main().catch((error) => {
  console.error(`Leave shift repair failed: ${error.message}`);
  process.exitCode = 1;
});
