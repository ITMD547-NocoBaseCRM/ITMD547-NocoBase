// Shows cancelled appointments in calendar history; their persisted color/title
// render them grey with a strikethrough instead of looking active.
const { createClient, formatErrors } = require('./nocobase-api');

const DATA_SCOPE = { logic: '$and', items: [] };
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
  const calendars = (await listAll(client)).filter((model) => model.use === 'CalendarBlockModel'
    && model.stepParams?.resourceSettings?.init?.collectionName === 'appointments');
  if (!calendars.length) throw new Error('No appointment calendars found');
  const results = [];
  for (const calendar of calendars) {
    const current = calendar.stepParams?.calendarSettings?.dataScope?.filter;
    const changed = JSON.stringify(current) !== JSON.stringify(DATA_SCOPE);
    if (!check && changed) {
      const configured = await client.request('flowSurfaces:configure', {
        method: 'POST', body: { target: { uid: calendar.uid }, changes: { dataScope: DATA_SCOPE } },
      });
      if (!configured.ok) throw fail(`update appointment calendar ${calendar.uid}`, configured);
    }
    results.push({ uid: calendar.uid, changed });
  }
  console.log(JSON.stringify({ status: 'ok', mode: check ? 'check' : 'apply', calendars: results }, null, 2));
}

main().catch((error) => { console.error(`Cancelled appointment style apply failed: ${error.message}`); process.exitCode = 1; });
