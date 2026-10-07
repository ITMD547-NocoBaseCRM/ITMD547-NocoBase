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
// A drag on the calendar hands the chosen start and end to this popup; forward them so the shift form opens pre-filled.
// Anything unexpected falls back to the plain availability screen, so the drawer is never blank.
let src = '/v/appointment-availability';
try {
  const args = (ctx.view && ctx.view.inputArgs) || {};
  const slot = args.formData || {};
  const parts = [];
  if (slot.startTime) parts.push('start=' + encodeURIComponent(String(slot.startTime)));
  if (slot.endTime) parts.push('end=' + encodeURIComponent(String(slot.endTime)));
  if (parts.length) src += '?' + parts.join('&');
} catch (error) { /* keep the plain screen */ }
// When the embedded screen saves a shift, refresh the calendar behind this drawer so the new shift shows at once.
const onMessage = (event) => {
  if (event.origin !== window.location.origin || !event.data || event.data.type !== 'parlour:shift-saved') return;
  try { const calendar = ctx.engine.getModel('__CALENDAR_UID__'); if (calendar && calendar.resource) calendar.resource.refresh(); } catch (error) { /* the Refresh button still works */ }
};
window.addEventListener('message', onMessage);
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
  const code = CODE.replace('__CALENDAR_UID__', calendar.uid);
  const existing = kids(grid.uid).find((m) => m.use === 'JSBlockModel');
  if (existing) {
    // Already swapped: only bring the block's script up to date.
    const current = existing.stepParams?.jsSettings?.runJs?.code;
    if (current === code) { console.log(JSON.stringify({ status: 'ok', changed: false, block: existing.uid })); return; }
    const stepParams = { ...existing.stepParams, jsSettings: { ...existing.stepParams.jsSettings, runJs: { version: 'v2', code } } };
    const synced = await client.request(`flowModels:update?filterByTk=${existing.uid}`, { method: 'POST', body: { stepParams } });
    if (!synced.ok) throw new Error(`code sync failed (${synced.status})`);
    console.log(JSON.stringify({ status: 'ok', changed: true, block: existing.uid, codeUpdated: true })); return;
  }
  const form = kids(grid.uid).find((m) => m.use === 'CreateFormModel');

  // Blocks must be added through flowSurfaces so the engine lays them out and links them to the grid;
  // inserting flowModels rows directly leaves an empty drawer.
  let result = await client.request('flowSurfaces:addBlock', { method: 'POST', body: {
    target: { uid: grid.uid }, type: 'jsBlock', settings: { title: 'Manage availability', version: 'v2', code },
  } });
  if (!result.ok) throw new Error(`addBlock failed (${result.status})`);
  const uid = result.json.data.uid;
  if (form) await client.request('flowSurfaces:removeNode', { method: 'POST', body: { target: { uid: form.uid } } });
  const tab = tree.find((m) => m.use === 'ChildPageTabModel');
  if (tab) await client.request(`flowModels:update?filterByTk=${tab.uid}`, { method: 'POST', body: { props: { title: 'Manage availability' }, stepParams: { pageTabSettings: { tab: { title: 'Manage availability' } } } } });
  console.log(JSON.stringify({ status: 'ok', changed: true, block: uid, removedForm: form && form.uid }));
}

main().catch((error) => { console.error(error.message); process.exit(1); });
