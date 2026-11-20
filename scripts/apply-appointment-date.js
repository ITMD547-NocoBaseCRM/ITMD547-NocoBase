// Splits the date from the start time on the appointment create forms.
//
// Usage: yarn apply:appointment-date [--check]
//
// Idempotent, for every appointment CreateFormModel that has a Start Time item:
//   1. adds a required "Date" item bound to appointments.appointmentDate (scripts/ui/appointment-date.js, a JS
//      editable field), or refreshes its code;
//   2. sets the Start Time item to scripts/ui/appointment-start-time.js with SEPARATE_DATE = true, so it shows only
//      the business-hours time list and combines it with the Date field;
//   3. lays Date | Start Time | End Time out on one row, where Start Time used to be. The layout is written to every
//      place NocoBase reads it from (props.layout, the legacy props.rows/sizes/rowOrder and
//      stepParams.gridSettings.grid), because different grids render from different copies.
// Edit forms are left alone: they get the same Start Time script with SEPARATE_DATE = false (combined picker).
//
// --check reports what would change and writes nothing. Same credentials and target rules as the other apply
// scripts (.env: NOCOBASE_API_TOKEN or INIT_ROOT_EMAIL/INIT_ROOT_PASSWORD; NOCOBASE_API_URL).

const fs = require('fs');
const path = require('path');
const { createClient, formatErrors } = require('./nocobase-api');

const COLLECTION = 'appointments';
const DATE_FIELD = 'appointmentDate';
const START_FIELD = 'startTime';
const END_FIELD = 'endTime';
const DATE_LABEL = 'Date';
const ROW_ID = 'rowWhen';
const DATE_SCRIPT = path.join(__dirname, 'ui', 'appointment-date.js');
const START_SCRIPT = path.join(__dirname, 'ui', 'appointment-start-time.js');
const VARIANT = /\/\*SEPARATE_DATE\*\/(true|false)/;

const fail = (what, result) => new Error(`${what} failed (${result.status}):\n${formatErrors(result.json)}`);

// The Start Time script with the SEPARATE_DATE switch filled in.
function startTimeCode(source, separate) {
  if (!VARIANT.test(source)) throw new Error('appointment-start-time.js has no /*SEPARATE_DATE*/ switch');
  return source.replace(VARIANT, `/*SEPARATE_DATE*/${separate ? 'true' : 'false'}`);
}

// Moves the date, start and end items into one row [date | start | end], placed where the start item was.
// Takes and returns a version-2 layout ({ rows: [{ id, cells: [{ id, items } | { id, rows }], sizes }] }; cells can
// hold nested rows). Never mutates its input; a layout that already has the row comes back unchanged.
function splitLayout(layout, { date, start, end }) {
  const ids = { date, start, end };
  if (hasSplitRow(layout, ids)) return layout;
  const moving = [date, start, end].filter(Boolean);
  const width = Math.floor(24 / moving.length);
  const whenRow = { id: ROW_ID, cells: moving.map((uid, i) => ({ id: `${ROW_ID}:cell:${i}`, items: [uid] })), sizes: moving.map(() => width) };
  let placed = false;
  const walk = (rows) => {
    const out = [];
    for (const row of rows || []) {
      const direct = (row.cells || []).some((c) => (c.items || []).includes(start));
      if (direct && !placed) { out.push(whenRow); placed = true; }
      const cells = [];
      const sizes = [];
      (row.cells || []).forEach((cell, i) => {
        let next;
        if (Array.isArray(cell.rows)) {
          const inner = walk(cell.rows);
          next = inner.length ? { ...cell, rows: inner } : null;
        } else {
          const items = (cell.items || []).filter((uid) => !moving.includes(uid));
          next = items.length ? { ...cell, items } : null;
        }
        if (next) { cells.push(next); sizes.push((row.sizes || [])[i]); }
      });
      if (!cells.length) continue;
      const same = cells.length === (row.cells || []).length && sizes.every((x) => typeof x === 'number');
      out.push({ ...row, cells, sizes: same ? sizes : cells.map(() => Math.floor(24 / cells.length)) });
    }
    return out;
  };
  const rows = walk(layout?.rows);
  if (!placed) rows.push(whenRow);
  return { ...(layout || {}), version: 2, rows };
}

const flatItems = (cell) => (Array.isArray(cell.rows) ? cell.rows.flatMap((r) => (r.cells || []).flatMap(flatItems)) : [...(cell.items || [])]);

// The same layout in the legacy props.rows / sizes / rowOrder shape (nested rows are flattened into their cell).
function legacyOf(layout) {
  const rows = {};
  const sizes = {};
  for (const row of layout.rows) {
    rows[row.id] = row.cells.map(flatItems);
    sizes[row.id] = row.sizes;
  }
  return { rows, sizes, rowOrder: layout.rows.map((r) => r.id) };
}

// True when some row, at any depth, is exactly [date] [start] [end].
function hasSplitRow(layout, { date, start, end }) {
  const want = JSON.stringify([[date], [start], [end]].filter((x) => x[0]));
  const scan = (rows) => (rows || []).some((row) => JSON.stringify((row.cells || []).map((c) => (Array.isArray(c.rows) ? null : c.items))) === want
    || (row.cells || []).some((c) => Array.isArray(c.rows) && scan(c.rows)));
  return scan(layout?.rows);
}

async function listAll(client) {
  const all = [];
  for (let page = 1; page <= 10; page += 1) {
    const result = await client.request(`flowModels:list?pageSize=1000&page=${page}`);
    if (!result.ok) throw fail('flowModels:list', result);
    const rows = result.json?.data || [];
    all.push(...rows);
    if (rows.length < 1000) break;
  }
  return all;
}

async function tree(client, uid) {
  const result = await client.request(`flowSurfaces:get?uid=${uid}`);
  if (!result.ok) throw fail(`flowSurfaces:get ${uid}`, result);
  return result.json.data.tree;
}

const one = (x) => (Array.isArray(x) ? x[0] : x);
const itemFor = (grid, fieldPath) => (grid?.subModels?.items || []).find((it) => it?.stepParams?.fieldSettings?.init?.fieldPath === fieldPath);
const codeOf = (item) => String(one(item?.subModels?.field)?.stepParams?.jsSettings?.runJs?.code || '');

async function setFieldCode(client, item, code) {
  const field = one(item.subModels.field);
  const stepParams = { ...field.stepParams, jsSettings: { ...(field.stepParams?.jsSettings || {}), runJs: { ...(field.stepParams?.jsSettings?.runJs || {}), version: 'v2', code } } };
  const result = await client.request(`flowModels:update?filterByTk=${field.uid}`, { method: 'POST', body: { stepParams } });
  if (!result.ok) throw fail(`flowModels:update ${field.uid}`, result);
}

async function main() {
  const check = process.argv.includes('--check');
  const dateCode = fs.readFileSync(DATE_SCRIPT, 'utf8');
  const startCode = startTimeCode(fs.readFileSync(START_SCRIPT, 'utf8'), true);
  const client = await createClient();
  const forms = (await listAll(client)).filter((m) => m.use === 'CreateFormModel' && m.stepParams?.resourceSettings?.init?.collectionName === COLLECTION);
  const results = [];
  for (const ref of forms) {
    let form = await tree(client, ref.uid);
    let grid = one(form.subModels?.grid);
    const start = itemFor(grid, START_FIELD);
    if (!start) { results.push({ form: ref.uid, status: 'no start time item (skipped)' }); continue; }
    const changes = [];
    let date = itemFor(grid, DATE_FIELD);
    if (!date) {
      changes.push('add Date');
      if (!check) {
        const added = await client.request('flowSurfaces:addField', { method: 'POST', body: { target: { uid: ref.uid }, fieldPath: DATE_FIELD, renderer: 'js', settings: { label: DATE_LABEL, version: 'v2', code: dateCode } } });
        if (!added.ok) throw fail(`addField ${DATE_FIELD} on ${ref.uid}`, added);
        form = await tree(client, ref.uid);
        grid = one(form.subModels?.grid);
        date = itemFor(grid, DATE_FIELD);
        if (!date) throw new Error(`Date item not found on ${ref.uid} after addField`);
      }
    } else if (codeOf(date) !== dateCode) {
      changes.push('refresh Date code');
      if (!check) await setFieldCode(client, date, dateCode);
    }
    if (date && date.props?.required !== true) {
      changes.push('make Date required');
      if (!check) {
        const result = await client.request(`flowModels:update?filterByTk=${date.uid}`, { method: 'POST', body: { props: { ...(date.props || {}), label: DATE_LABEL, required: true } } });
        if (!result.ok) throw fail(`flowModels:update ${date.uid}`, result);
      }
    }
    if (codeOf(start) !== startCode) {
      changes.push('Start Time → time only');
      if (!check) await setFieldCode(client, start, startCode);
    }
    const end = itemFor(grid, END_FIELD);
    const ids = { date: date?.uid || '(new)', start: start.uid, end: end?.uid };
    const stores = [grid.props?.layout, grid.stepParams?.gridSettings?.grid?.layout].filter(Boolean);
    const laidOut = stores.length > 0 && stores.every((l) => hasSplitRow(l, ids));
    if (!laidOut) {
      changes.push('one row: Date | Start Time | End Time');
      if (!check) {
        const base = grid.props?.layout || grid.stepParams?.gridSettings?.grid?.layout;
        const layout = splitLayout(base, ids);
        const props = { ...(grid.props || {}), layout, ...legacyOf(layout) };
        const stepParams = { ...(grid.stepParams || {}) };
        if (stepParams.gridSettings?.grid) {
          const g = { ...stepParams.gridSettings.grid, layout };
          if (g.rows) Object.assign(g, legacyOf(layout));
          stepParams.gridSettings = { ...stepParams.gridSettings, grid: g };
        }
        const result = await client.request(`flowModels:update?filterByTk=${grid.uid}`, { method: 'POST', body: { props, stepParams } });
        if (!result.ok) throw fail(`flowModels:update ${grid.uid}`, result);
      }
    }
    results.push({ form: ref.uid, status: changes.length ? (check ? `would: ${changes.join(', ')}` : changes.join(', ')) : 'up to date' });
  }
  if (!results.length) throw new Error('No appointment create forms found');
  console.log(JSON.stringify({ status: 'ok', mode: check ? 'check' : 'apply', target: client.baseUrl, forms: results }, null, 2));
}

module.exports = { splitLayout, legacyOf, startTimeCode, hasSplitRow };

if (require.main === module) {
  main().catch((error) => {
    console.error(`Appointment date split apply failed: ${error.message}`);
    process.exitCode = 1;
  });
}
