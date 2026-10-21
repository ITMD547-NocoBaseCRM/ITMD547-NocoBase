// Keeps leave records in the availability manager without rendering their projected
// employeeShifts rows as working shifts on either Shift calendar.
//
// Usage: node scripts/apply-shift-calendar-hide-leave.js [--check]

// Safe to repeat. Existing calendar settings are preserved.

const { createClient, formatErrors } = require('./nocobase-api');

const COLLECTION = 'employeeShifts';
const FILTER = {
  logic: '$and',
  items: [{ path: 'status', operator: '$ne', value: 'onLeave' }],
};
// Use the shift's stored display label. Relation-backed staff.firstName can be absent from
// the calendar's immediate event payload, causing valid shifts to render as "Untitle".
const TITLE_FIELD = 'calendarTitle';

const fail = (what, result) => new Error(`${what} failed (${result.status}):\n${formatErrors(result.json)}`);

async function listAll(client) {
  const all = [];
  for (let page = 1; page <= 10; page += 1) {
    const result = await client.request(`flowModels:list?pageSize=1000&page=${page}`);
    if (!result.ok) throw fail('list flow models', result);
    const rows = result.json?.data || [];
    all.push(...rows);
    if (rows.length < 1000) break;
  }
  return all;
}

async function main() {
  const check = process.argv.includes('--check');
  const client = await createClient();
  const calendars = (await listAll(client)).filter((model) =>
    model.use === 'CalendarBlockModel'
      && model.stepParams?.resourceSettings?.init?.collectionName === COLLECTION,
  );
  if (!calendars.length) throw new Error('No Employee shifts calendars found');

  const results = [];
  for (const calendar of calendars) {
    const current = calendar.stepParams?.calendarSettings?.dataScope?.filter;
    const currentTitle = calendar.stepParams?.calendarSettings?.titleField?.titleField;
    const upToDate = JSON.stringify(current) === JSON.stringify(FILTER) && currentTitle === TITLE_FIELD;
    if (!upToDate && !check) {
      const result = await client.request('flowSurfaces:configure', {
        method: 'POST',
        body: { target: { uid: calendar.uid }, changes: { dataScope: FILTER, titleField: TITLE_FIELD } },
      });
      if (!result.ok) throw fail(`update Shift calendar ${calendar.uid}`, result);
    }
    results.push({ uid: calendar.uid, changed: !upToDate, dryRun: check || undefined });
  }

  console.log(JSON.stringify({
    status: 'ok',
    mode: check ? 'check' : 'apply',
    target: client.baseUrl,
    filter: FILTER,
    titleField: TITLE_FIELD,
    calendars: results,
  }, null, 2));
}

main().catch((error) => {
  console.error(`Shift calendar leave filter failed: ${error.message}`);
  process.exitCode = 1;
});
