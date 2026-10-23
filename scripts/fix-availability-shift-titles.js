// Repairs plugin-generated availability shifts whose calendar title is generic or stale.
// Safe to repeat; appointment and shift times are not changed.
const { createClient, formatErrors } = require('./nocobase-api');

const fail = (what, result) => new Error(`${what} failed (${result.status}):\n${formatErrors(result.json)}`);
const nameOf = (staff) => [staff?.firstName, staff?.lastName].filter(Boolean).join(' ').trim() || 'Staff member';

async function main() {
  const check = process.argv.includes('--check');
  const client = await createClient();
  const [staffResult, shiftResult] = await Promise.all([
    client.request('staff:list?paginate=false&fields=id,firstName,lastName'),
    client.request('employeeShifts:list?paginate=false&fields=id,staffId,status,shiftType,calendarTitle,notes'),
  ]);
  if (!staffResult.ok) throw fail('list staff', staffResult);
  if (!shiftResult.ok) throw fail('list employee shifts', shiftResult);

  const names = new Map((staffResult.json?.data || []).map((staff) => [String(staff.id), nameOf(staff)]));
  const repairs = (shiftResult.json?.data || [])
    .filter((shift) => shift.shiftType === 'availability' || String(shift.notes || '').includes('[Availability schedule '))
    .map((shift) => ({
      id: shift.id,
      previous: shift.calendarTitle,
      title: shift.status === 'onLeave'
        ? `On leave — ${names.get(String(shift.staffId)) || 'Staff member'}`
        : names.get(String(shift.staffId)) || 'Staff member',
    }))
    .filter((shift) => shift.previous !== shift.title);

  if (!check) {
    for (const repair of repairs) {
      const result = await client.request(`employeeShifts:update?filterByTk=${encodeURIComponent(repair.id)}`, {
        method: 'POST', body: { calendarTitle: repair.title },
      });
      if (!result.ok) throw fail(`update employee shift ${repair.id}`, result);
    }
  }

  console.log(JSON.stringify({ status: 'ok', mode: check ? 'check' : 'apply', repairs }, null, 2));
}

main().catch((error) => {
  console.error(`Availability title repair failed: ${error.message}`);
  process.exitCode = 1;
});
