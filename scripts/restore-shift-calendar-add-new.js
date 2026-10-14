// Puts the native "Add new" shift form back into the Employee shifts calendar's click/drag drawer.
//
// Usage: node scripts/restore-shift-calendar-add-new.js
//
// This is the counterpart of apply-shift-calendar-availability.js, which swapped that form for the embedded
// availability screen. The drawer is a popup template shared by every calendar on employeeShifts, so this
// restores all of them at once. The calendar pre-fills the form's start/end from a dragged slot by itself;
// a linkage rule added here fills the shift date from the start time as well.
//
// Safe to repeat: every step checks the live state first and only adds what is missing.

const { createClient } = require('./nocobase-api');

const SHIFTS = 'employeeShifts';
// addBlock's own `fields` option does not materialise form items for a createForm, so fields are added one by one.
const FIELDS = [{ fieldPath: 'staff', fieldType: 'select' }, { fieldPath: 'shiftDate' }, { fieldPath: 'startTime' }, { fieldPath: 'endTime' }, { fieldPath: 'shiftType' }, { fieldPath: 'status' }, { fieldPath: 'notes' }];
const SHIFT_DATE_RULE_KEY = 'shiftDateFromStart';
const SHIFT_DATE_CODE = [
  '// Shift date follows the start time (local calendar day), e.g. after dragging a slot on the calendar.',
  'const start = ctx.formValues?.startTime;',
  'if (!start) return null;',
  'const d = new Date(start);',
  'if (Number.isNaN(d.getTime())) return null;',
  "const pad = (n) => String(n).padStart(2, '0');",
  '',
  'return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;',
].join('\n');

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

// flowModels:list cannot filter by parentId, so the form's own fields are read from its surface document.
async function formFields(client, formUid) {
  const result = await client.request(`flowSurfaces:get?uid=${formUid}`);
  if (!result.ok) throw new Error(`flowSurfaces:get failed (${result.status})`);
  // The document repeats a node wherever it is referenced, so items are keyed by uid.
  const items = new Map();
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.use === 'FormItemModel' && node.uid && node.stepParams?.fieldSettings?.init?.fieldPath) {
      const known = items.get(node.uid) || { uid: node.uid, fieldPath: node.stepParams.fieldSettings.init.fieldPath };
      if (node.subModels?.field?.uid) known.field = node.subModels.field;
      items.set(node.uid, known);
    }
    for (const value of Object.values(node)) if (value && typeof value === 'object') walk(value);
  };
  walk(result.json.data || result.json);
  return [...items.values()];
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
  const changes = [];

  const availabilityBlock = kids(grid.uid).find((m) => m.use === 'JSBlockModel');
  if (availabilityBlock) {
    const removed = await client.request('flowSurfaces:removeNode', { method: 'POST', body: { target: { uid: availabilityBlock.uid } } });
    if (!removed.ok) throw new Error(`removeNode failed (${removed.status})`);
    changes.push(`removed availability block ${availabilityBlock.uid}`);
  }

  let formUid = (kids(grid.uid).find((m) => m.use === 'CreateFormModel') || {}).uid;
  if (!formUid) {
    const added = await client.request('flowSurfaces:addBlock', { method: 'POST', body: { target: { uid: grid.uid }, type: 'createForm', resource: { dataSourceKey: 'main', collectionName: SHIFTS } } });
    if (!added.ok) throw new Error(`addBlock failed (${added.status}): ${JSON.stringify(added.json).slice(0, 300)}`);
    formUid = added.json.data.uid;
    changes.push(`added create form ${formUid}`);
  }

  let present = await formFields(client, formUid);
  for (const spec of FIELDS) {
    if (present.some((item) => item.fieldPath === spec.fieldPath)) continue;
    const added = await client.request('flowSurfaces:addField', { method: 'POST', body: { target: { uid: formUid }, ...spec } });
    if (!added.ok) throw new Error(`addField ${spec.fieldPath} failed (${added.status})`);
    changes.push(`added field ${spec.fieldPath}`);
  }
  present = await formFields(client, formUid);
  // Keep one item per field. Duplicates appear when a field is added twice (addBlock's `fields` option does
  // create items, just not visibly through flowModels:list); for shiftDate prefer the date-picker item.
  const byPath = new Map();
  for (const item of present) {
    const current = byPath.get(item.fieldPath);
    const better = !current || (item.fieldPath === 'shiftDate' && item.field?.use === 'DateOnlyFieldModel' && current.field?.use !== 'DateOnlyFieldModel');
    if (better) { if (current) byPath.set(`${item.fieldPath}#dup${current.uid}`, current); byPath.set(item.fieldPath, item); } else byPath.set(`${item.fieldPath}#dup${item.uid}`, item);
  }
  for (const [key, item] of byPath) {
    if (!key.includes('#dup') || !item.uid) continue;
    const removed = await client.request('flowSurfaces:removeNode', { method: 'POST', body: { target: { uid: item.uid } } });
    if (!removed.ok) throw new Error(`removeNode duplicate ${item.fieldPath} failed (${removed.status})`);
    changes.push(`removed duplicate field ${item.fieldPath}`);
  }
  present = await formFields(client, formUid);
  // The builder picks a plain text input for the dateOnly column; the original form used the date picker.
  const shiftDate = present.find((item) => item.fieldPath === 'shiftDate');
  if (shiftDate?.field?.uid && shiftDate.field.use !== 'DateOnlyFieldModel') {
    const updated = await client.request(`flowModels:update?filterByTk=${shiftDate.field.uid}`, { method: 'POST', body: { use: 'DateOnlyFieldModel' } });
    if (!updated.ok) throw new Error(`shiftDate field update failed (${updated.status})`);
    changes.push('shiftDate uses the date picker');
  }

  const meta = await client.request('flowSurfaces:getReactionMeta', { method: 'POST', body: { target: { uid: formUid } } });
  const linkage = ((meta.json?.data?.capabilities) || []).find((cap) => cap.kind === 'fieldLinkage');
  if (linkage && !(linkage.normalizedRules || []).some((rule) => rule.key === SHIFT_DATE_RULE_KEY)) {
    const rules = [...(linkage.normalizedRules || []), {
      key: SHIFT_DATE_RULE_KEY, title: 'Shift date from start time',
      when: { logic: '$and', items: [{ path: 'formValues.startTime', operator: '$notEmpty' }, { path: 'formValues.shiftDate', operator: '$empty' }] },
      then: [{ type: 'assignField', items: [{ targetPath: 'shiftDate', value: { source: 'runjs', version: 'v2', code: SHIFT_DATE_CODE } }] }],
    }];
    const set = await client.request('flowSurfaces:setFieldLinkageRules', { method: 'POST', body: { target: { uid: formUid }, expectedFingerprint: linkage.fingerprint, rules } });
    if (!set.ok) throw new Error(`setFieldLinkageRules failed (${set.status}): ${JSON.stringify(set.json).slice(0, 300)}`);
    changes.push('added shift date linkage rule');
  }

  const tab = tree.find((m) => m.use === 'ChildPageTabModel');
  if (tab && tab.props?.title !== '{{t("Add new")}}') {
    await client.request(`flowModels:update?filterByTk=${tab.uid}`, { method: 'POST', body: { props: { title: '{{t("Add new")}}' }, stepParams: { pageTabSettings: { tab: { title: '{{t("Add new")}}' } } } } });
    changes.push('tab renamed to Add new');
  }

  console.log(JSON.stringify({ status: 'ok', changed: changes.length > 0, form: formUid, changes }));
}

main().catch((error) => { console.error(error.message); process.exit(1); });
