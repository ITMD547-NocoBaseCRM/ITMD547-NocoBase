// Replaces End Time on appointment create/edit forms with a duration-aware picker.
const fs = require('fs');
const path = require('path');
const { createClient, formatErrors, getSurface } = require('./nocobase-api');
const { FORM_LAYOUT_ROWS } = require('./appointments-page-blueprint');
const { findForms, formGridLayout, formItemsByPath } = require('./appointments-page-layout');

const CODE = fs.readFileSync(path.join(__dirname, 'ui', 'appointment-duration-aware-end-time.js'), 'utf8');
const fail = (what, result) => new Error(`${what} failed (${result.status}):\n${formatErrors(result.json)}`);

function completeFormLayout(form) {
  const byPath = formItemsByPath(form);
  const items = form?.subModels?.grid?.subModels?.items || [];
  const rows = [];
  for (const row of FORM_LAYOUT_ROWS) {
    const present = row.filter(([fieldPath]) => byPath[fieldPath]);
    if (present.length) rows.push(present.map(([fieldPath, span]) => [byPath[fieldPath], span]));
  }
  const included = new Set(rows.flat().map(([uid]) => uid));
  for (const item of items) if (!included.has(item.uid)) rows.push([[item.uid, 24]]);
  const keys = rows.map((_, index) => `row${index + 1}`);
  return {
    rows: Object.fromEntries(rows.map((row, index) => [keys[index], row.map(([uid]) => [uid])])),
    sizes: Object.fromEntries(rows.map((row, index) => [keys[index], row.map(([, span]) => span)])),
    rowOrder: keys,
  };
}

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

function endTimeItems(form) {
  return (form?.subModels?.grid?.subModels?.items || []).filter(
    (item) => item?.stepParams?.fieldSettings?.init?.fieldPath === 'endTime',
  );
}

function codeOf(item) {
  const field = Array.isArray(item?.subModels?.field) ? item.subModels.field[0] : item?.subModels?.field;
  return field?.stepParams?.jsSettings?.runJs?.code;
}

async function updateForm(client, ref, check) {
  const tree = await getSurface(client, { uid: ref.uid });
  const form = findForms(tree).find((node) => node.uid === ref.uid);
  if (!form) throw new Error(`Appointment form ${ref.uid} was not found`);
  const currentItems = endTimeItems(form);
  const keeper = currentItems.find((item) => codeOf(item) === CODE);
  const obsolete = keeper ? currentItems.filter((item) => item.uid !== keeper.uid) : currentItems;
  if (check) return { form: ref.uid, type: ref.use, changed: !keeper || obsolete.length > 0 };
  if (keeper && !obsolete.length) return { form: ref.uid, type: ref.use, changed: false };
  for (const current of obsolete) {
    const removed = await client.request('flowSurfaces:removeNode', { method: 'POST', body: { target: { uid: current.uid } } });
    if (!removed.ok) throw fail(`remove End Time on ${ref.uid}`, removed);
  }
  if (!keeper) {
    const added = await client.request('flowSurfaces:addField', {
      method: 'POST',
      body: { target: { uid: form.uid }, fieldPath: 'endTime', renderer: 'js', settings: { label: 'End Time', version: 'v2', code: CODE } },
    });
    if (!added.ok) throw fail(`add duration-aware End Time on ${ref.uid}`, added);
  }
  const freshTree = await getSurface(client, { uid: ref.uid });
  const fresh = findForms(freshTree).find((node) => node.uid === ref.uid);
  const layout = await client.request('flowSurfaces:setLayout', {
    method: 'POST', body: { target: { uid: fresh.subModels.grid.uid }, ...completeFormLayout(fresh) },
  });
  if (!layout.ok) throw fail(`restore form layout on ${ref.uid}`, layout);
  return { form: ref.uid, type: ref.use, changed: true };
}

async function main() {
  const check = process.argv.includes('--check');
  const client = await createClient();
  const forms = (await listAll(client)).filter((model) => /^(Create|Edit)FormModel$/.test(model.use)
    && model.stepParams?.resourceSettings?.init?.collectionName === 'appointments');
  if (!forms.length) throw new Error('No appointment create/edit forms found');
  const results = [];
  for (const form of forms) results.push(await updateForm(client, form, check));
  console.log(JSON.stringify({ status: 'ok', mode: check ? 'check' : 'apply', target: client.baseUrl, forms: results }, null, 2));
}

main().catch((error) => {
  console.error(`Appointment duration apply failed: ${error.message}`);
  process.exitCode = 1;
});
