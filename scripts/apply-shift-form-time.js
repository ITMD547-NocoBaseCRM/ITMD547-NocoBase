// Aligns the shift calendar quick-create time inputs with America/Chicago calendar time.
const fs = require('fs');
const path = require('path');
const { createClient, formatErrors, getSurface } = require('./nocobase-api');
const { findNode } = require('./appointments-page-layout');

const CODE = fs.readFileSync(path.join(__dirname, 'ui', 'shift-form-time.js'), 'utf8');
const PATHS = new Set(['startTime', 'endTime']);
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
  const forms = (await listAll(client)).filter((model) => model.use === 'CreateFormModel'
    && model.stepParams?.resourceSettings?.init?.collectionName === 'employeeShifts');
  if (!forms.length) throw new Error('No employeeShifts create form found');
  const results = [];

  for (const form of forms) {
    const tree = await getSurface(client, { uid: form.uid });
    const fields = [];
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      const fieldPath = node.stepParams?.fieldSettings?.init?.fieldPath;
      if (node.use === 'JSEditableFieldModel' && PATHS.has(fieldPath)) fields.push({ node, fieldPath });
      for (const value of Object.values(node.subModels || {})) {
        for (const child of (Array.isArray(value) ? value : [value])) walk(child);
      }
    };
    walk(tree);
    for (const { node, fieldPath } of fields) {
      const changed = node.stepParams?.jsSettings?.runJs?.code !== CODE;
      if (!check && changed) {
        const updated = await client.request('flowSurfaces:configure', {
          method: 'POST', body: { target: { uid: node.uid }, changes: { version: 'v2', code: CODE } },
        });
        if (!updated.ok) throw fail(`update ${fieldPath} on ${form.uid}`, updated);
      }
      results.push({ form: form.uid, field: fieldPath, uid: node.uid, changed });
    }
  }
  if (results.length !== forms.length * PATHS.size) throw new Error('Each shift create form must contain Start Time and End Time JS fields');

  if (!check) {
    for (const result of results) {
      const tree = await getSurface(client, { uid: result.form });
      const saved = findNode(tree, (node) => node.uid === result.uid);
      if (saved?.stepParams?.jsSettings?.runJs?.code !== CODE) throw new Error(`Readback failed for ${result.field}`);
    }
  }
  console.log(JSON.stringify({ status: 'ok', mode: check ? 'check' : 'apply', fields: results }, null, 2));
}

main().catch((error) => { console.error(`Shift form time apply failed: ${error.message}`); process.exitCode = 1; });
