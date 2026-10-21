// Adds availability-aware staff assignment to appointment Details blocks.
const fs = require('fs');
const path = require('path');
const { createClient, formatErrors, getSurface } = require('./nocobase-api');
const { findNode } = require('./appointments-page-layout');

const CODE = fs.readFileSync(path.join(__dirname, 'ui', 'appointment-details-staff.js'), 'utf8');
const FIELD = 'staff.firstName';
const ORDER = ['customer.firstName', 'customer.skinSensitivities', 'customer.phone', FIELD, 'category', 'status', 'appointmentDate', 'startTime', 'endTime', 'notes', 'createdAt', 'updatedAt'];
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
const itemPath = (item) => item?.stepParams?.fieldSettings?.init?.fieldPath;
const codeOf = (item) => {
  const field = Array.isArray(item?.subModels?.field) ? item.subModels.field[0] : item?.subModels?.field;
  return field?.stepParams?.jsSettings?.runJs?.code;
};
function layoutFor(details) {
  const items = details?.subModels?.grid?.subModels?.items || [];
  const byPath = new Map(items.map((item) => [itemPath(item), item.uid]));
  const ordered = ORDER.map((field) => byPath.get(field)).filter(Boolean);
  const included = new Set(ordered);
  for (const item of items) if (!included.has(item.uid)) ordered.push(item.uid);
  const rows = [];
  for (let index = 0; index < ordered.length; index += 2) rows.push(ordered.slice(index, index + 2));
  const keys = rows.map((_, index) => `row${index + 1}`);
  return {
    rows: Object.fromEntries(rows.map((row, index) => [keys[index], row.map((uid) => [uid])])),
    sizes: Object.fromEntries(rows.map((row, index) => [keys[index], row.map(() => row.length === 1 ? 24 : 12)])),
    rowOrder: keys,
  };
}

async function update(client, ref, check) {
  const tree = await getSurface(client, { uid: ref.uid });
  const details = findNode(tree, (node) => node.uid === ref.uid && node.use === 'DetailsBlockModel');
  if (!details) throw new Error(`Appointment Details block ${ref.uid} not found`);
  const items = details.subModels?.grid?.subModels?.items || [];
  const matches = items.filter((item) => itemPath(item) === FIELD);
  const keeper = matches.find((item) => codeOf(item) === CODE);
  const obsolete = keeper ? matches.filter((item) => item.uid !== keeper.uid) : matches;
  if (check) return { details: ref.uid, changed: !keeper || obsolete.length > 0 };
  for (const item of obsolete) {
    const removed = await client.request('flowSurfaces:removeNode', { method: 'POST', body: { target: { uid: item.uid } } });
    if (!removed.ok) throw fail(`remove Technician field on ${ref.uid}`, removed);
  }
  if (!keeper) {
    const added = await client.request('flowSurfaces:addField', {
      method: 'POST', body: { target: { uid: details.uid }, fieldPath: FIELD, renderer: 'js', settings: { label: 'Technician', version: 'v2', code: CODE } },
    });
    if (!added.ok) throw fail(`add assignable Technician field on ${ref.uid}`, added);
  }
  const freshTree = await getSurface(client, { uid: ref.uid });
  const fresh = findNode(freshTree, (node) => node.uid === ref.uid && node.use === 'DetailsBlockModel');
  const layout = await client.request('flowSurfaces:setLayout', {
    method: 'POST', body: { target: { uid: fresh.subModels.grid.uid }, ...layoutFor(fresh) },
  });
  if (!layout.ok) throw fail(`restore Details layout on ${ref.uid}`, layout);
  return { details: ref.uid, changed: true };
}

async function main() {
  const check = process.argv.includes('--check');
  const client = await createClient();
  const refs = (await listAll(client)).filter((model) => model.use === 'DetailsBlockModel'
    && model.stepParams?.resourceSettings?.init?.collectionName === 'appointments');
  if (!refs.length) throw new Error('No appointment Details blocks found');
  const results = [];
  for (const ref of refs) results.push(await update(client, ref, check));
  console.log(JSON.stringify({ status: 'ok', mode: check ? 'check' : 'apply', target: client.baseUrl, details: results }, null, 2));
}
main().catch((error) => { console.error(`Appointment Details staff apply failed: ${error.message}`); process.exitCode = 1; });
