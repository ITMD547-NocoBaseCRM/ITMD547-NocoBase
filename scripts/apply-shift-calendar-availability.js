// Makes a click on the Employee shifts calendar open the availability manager instead of the plain shift form.
//
// Usage: node scripts/apply-shift-calendar-availability.js
//
// The calendar's quick-create drawer holds a CreateForm for employeeShifts. This replaces that form with a JS
// block that embeds /v/appointment-availability (the same screen as the "Manage availability" button), so there
// is a single place to add schedules, overrides and leave. Safe to repeat: it does nothing once the swap is done.

const { createClient } = require('./nocobase-api');

const SHIFTS = 'employeeShifts';
const CODE = `const h = ctx.React.createElement;
// A drag on the calendar hands the chosen start and end to this popup; forward them so the schedule form opens pre-filled.
const args = (ctx.view && ctx.view.inputArgs) || {};
const slot = args.formData || {};
const query = new URLSearchParams();
if (slot.startTime) query.set('start', String(slot.startTime));
if (slot.endTime) query.set('end', String(slot.endTime));
const src = '/v/appointment-availability' + (query.toString() ? '?' + query.toString() : '');
ctx.render(h('iframe', { src, title: 'Manage availability', style: { width: '100%', height: '75vh', border: 0 } }));
`;

async function listAll(client) {
  const all = [];
  for (let page = 1; page <= 10; page += 1) {
    const result = await client.request(`flowModels:list?pageSize=1000&page=${page}`);
    const rows = (result.json && result.json.data) || [];
    all.push(...rows);
    if (rows.length < 1000) break;
  }
  return all;
}

async function main() {
  const client = await createClient();
  const all = await listAll(client);
  const calendar = all.find((m) => m.use === 'CalendarBlockModel' && JSON.stringify(m.stepParams?.resourceSettings || {}).includes(`"${SHIFTS}"`));
  if (!calendar) throw new Error('Shift calendar block not found');
  const popupUid = calendar.stepParams?.calendarSettings?.quickCreatePopupSettings?.uid;
  const kids = (uid) => all.filter((m) => m.parentId === uid);
  const walk = (uid) => kids(uid).flatMap((m) => [m, ...walk(m.uid)]);
  const tree = walk(popupUid);
  const grid = tree.find((m) => m.use === 'BlockGridModel');
  if (!grid) throw new Error('Quick-create popup grid not found');
  const existing = kids(grid.uid).find((m) => m.use === 'JSBlockModel');
  if (existing) { console.log(JSON.stringify({ status: 'ok', changed: false, block: existing.uid })); return; }
  const form = kids(grid.uid).find((m) => m.use === 'CreateFormModel');

  // Blocks must be added through flowSurfaces so the engine lays them out and links them to the grid;
  // inserting flowModels rows directly leaves an empty drawer.
  let result = await client.request('flowSurfaces:addBlock', { method: 'POST', body: {
    target: { uid: grid.uid }, type: 'jsBlock', settings: { title: 'Manage availability', version: 'v2', code: CODE },
  } });
  if (!result.ok) throw new Error(`addBlock failed (${result.status})`);
  const uid = result.json.data.uid;
  if (form) await client.request('flowSurfaces:removeNode', { method: 'POST', body: { target: { uid: form.uid } } });
  const tab = tree.find((m) => m.use === 'ChildPageTabModel');
  if (tab) await client.request(`flowModels:update?filterByTk=${tab.uid}`, { method: 'POST', body: { props: { title: 'Manage availability' }, stepParams: { pageTabSettings: { tab: { title: 'Manage availability' } } } } });
  console.log(JSON.stringify({ status: 'ok', changed: true, block: uid, removedForm: form && form.uid }));
}

main().catch((error) => { console.error(error.message); process.exit(1); });
