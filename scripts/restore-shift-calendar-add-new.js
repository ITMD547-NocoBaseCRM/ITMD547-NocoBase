// Puts the native "Add new" shift form back into the Employee shifts calendar's click/drag drawer.
//
// Usage: node scripts/restore-shift-calendar-add-new.js
//
// This is the counterpart of apply-shift-calendar-availability.js, which swapped that form for the embedded
// availability screen. The drawer is a popup template shared by every calendar on employeeShifts, so this
// restores all of them at once. The calendar pre-fills the form's start/end from a dragged slot by itself.
// Safe to repeat: it does nothing once a create form is already in the drawer.

const { createClient } = require('./nocobase-api');

const SHIFTS = 'employeeShifts';
const FIELDS = [{ fieldPath: 'staff', fieldType: 'select' }, 'shiftDate', 'startTime', 'endTime', 'shiftType', 'status', 'notes'];

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

  const form = kids(grid.uid).find((m) => m.use === 'CreateFormModel');
  const availabilityBlock = kids(grid.uid).find((m) => m.use === 'JSBlockModel');
  if (form && !availabilityBlock) { console.log(JSON.stringify({ status: 'ok', changed: false, form: form.uid })); return; }

  if (availabilityBlock) {
    const removed = await client.request('flowSurfaces:removeNode', { method: 'POST', body: { target: { uid: availabilityBlock.uid } } });
    if (!removed.ok) throw new Error(`removeNode failed (${removed.status})`);
  }
  let formUid = form && form.uid;
  if (!formUid) {
    const added = await client.request('flowSurfaces:addBlock', { method: 'POST', body: {
      target: { uid: grid.uid }, type: 'createForm', resource: { dataSourceKey: 'main', collectionName: SHIFTS }, fields: FIELDS,
    } });
    if (!added.ok) throw new Error(`addBlock failed (${added.status}): ${JSON.stringify(added.json).slice(0, 300)}`);
    formUid = added.json.data.uid;
  }
  const tab = tree.find((m) => m.use === 'ChildPageTabModel');
  if (tab) await client.request(`flowModels:update?filterByTk=${tab.uid}`, { method: 'POST', body: { props: { title: '{{t("Add new")}}' }, stepParams: { pageTabSettings: { tab: { title: '{{t("Add new")}}' } } } } });
  console.log(JSON.stringify({ status: 'ok', changed: true, form: formUid, removedAvailabilityBlock: availabilityBlock && availabilityBlock.uid }));
}

main().catch((error) => { console.error(error.message); process.exit(1); });
