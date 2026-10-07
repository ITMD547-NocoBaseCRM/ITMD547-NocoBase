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
ctx.render(h('iframe', { src: '/v/appointment-availability', title: 'Manage availability', style: { width: '100%', height: '75vh', border: 0 } }));
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

  const uid = `avl${Math.random().toString(36).slice(2, 10)}`;
  let result = await client.request('flowModels:create', { method: 'POST', body: {
    uid, name: uid, parentId: grid.uid, subKey: 'items', subType: 'array', use: 'JSBlockModel', props: {}, decoratorProps: {},
    stepParams: { jsSettings: { runJs: { version: 'v2', code: CODE }, showBlockCard: { showBlockCard: false } } },
  } });
  if (!result.ok) throw new Error(`create failed (${result.status})`);
  const layout = { rows: { row1: [[uid]] }, sizes: { row1: [24] }, rowOrder: ['row1'] };
  result = await client.request(`flowModels:update?filterByTk=${grid.uid}`, { method: 'POST', body: { props: layout, stepParams: { gridSettings: { grid: layout } } } });
  if (!result.ok) throw new Error(`layout failed (${result.status})`);
  if (form) await client.request(`flowModels:destroy?filterByTk=${form.uid}`, { method: 'POST' });
  const tab = tree.find((m) => m.use === 'ChildPageTabModel');
  if (tab) await client.request(`flowModels:update?filterByTk=${tab.uid}`, { method: 'POST', body: { props: { title: 'Manage availability' }, stepParams: { pageTabSettings: { tab: { title: 'Manage availability' } } } } });
  console.log(JSON.stringify({ status: 'ok', changed: true, block: uid, removedForm: form && form.uid }));
}

main().catch((error) => { console.error(error.message); process.exit(1); });
