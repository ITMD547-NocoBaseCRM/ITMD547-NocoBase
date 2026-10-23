// Keeps shift Details time fields aligned with the calendar's America/Chicago display.
const fs = require('fs');
const path = require('path');
const { createClient, formatErrors, getSurface } = require('./nocobase-api');
const { findNode } = require('./appointments-page-layout');

const CODE = fs.readFileSync(path.join(__dirname, 'ui', 'shift-details-time.js'), 'utf8');
const FIELDS = new Set(['startTime', 'endTime']);
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
const fieldOf = (item) => Array.isArray(item?.subModels?.field) ? item.subModels.field[0] : item?.subModels?.field;

async function main() {
  const check = process.argv.includes('--check');
  const client = await createClient();
  const refs = (await listAll(client)).filter((model) => model.use === 'DetailsBlockModel'
    && model.stepParams?.resourceSettings?.init?.collectionName === 'employeeShifts');
  if (!refs.length) throw new Error('No employeeShifts Details blocks found');

  const results = [];
  for (const ref of refs) {
    const tree = await getSurface(client, { uid: ref.uid });
    const details = findNode(tree, (node) => node.uid === ref.uid && node.use === 'DetailsBlockModel');
    const items = details?.subModels?.grid?.subModels?.items || [];
    for (const item of items.filter((candidate) => FIELDS.has(itemPath(candidate)))) {
      const field = fieldOf(item);
      if (field?.use !== 'JSFieldModel') throw new Error(`${itemPath(item)} on ${ref.uid} is not a JSFieldModel`);
      const current = field.stepParams?.jsSettings?.runJs?.code || '';
      const changed = current !== CODE;
      if (!check && changed) {
        const updated = await client.request('flowSurfaces:configure', {
          method: 'POST', body: { target: { uid: field.uid }, changes: { version: 'v2', code: CODE } },
        });
        if (!updated.ok) throw fail(`update ${itemPath(item)} on ${ref.uid}`, updated);
      }
      results.push({ details: ref.uid, field: itemPath(item), uid: field.uid, changed });
    }
  }

  if (results.length !== refs.length * FIELDS.size) throw new Error('Each shift Details block must contain Start Time and End Time');
  if (!check) {
    for (const result of results) {
      const tree = await getSurface(client, { uid: result.details });
      const saved = findNode(tree, (node) => node.uid === result.uid);
      if (saved?.stepParams?.jsSettings?.runJs?.code !== CODE) throw new Error(`Readback failed for ${result.field}`);
    }
  }
  console.log(JSON.stringify({ status: 'ok', mode: check ? 'check' : 'apply', fields: results }, null, 2));
}

main().catch((error) => { console.error(`Shift Details time apply failed: ${error.message}`); process.exitCode = 1; });
