// Completes the Customers page create and edit forms.
//
// Usage: yarn apply:customer-forms [--check]
//
// The Edit form had drifted to six fields (no status, date of birth or skin profile), and the Create form had no date
// of birth. This script brings both to the same field list, in a two-column layout, and leaves anything else on the
// forms untouched. Safe to repeat: fields already present are kept (their uids do not change), only missing ones are
// added, then the grid is re-laid out. Run `yarn apply:customer-required-fields` afterwards if the required marks
// are missing (this script calls the same logic for the core fields).
//
// Signs in with NOCOBASE_API_TOKEN or the INIT_ROOT_* credentials from .env; NOCOBASE_API_URL overrides the target.

const { createClient, formatErrors } = require('./nocobase-api');
const { findForms, formGridLayout, formItemsByPath, missingFormFields } = require('./appointments-page-layout');

const COLLECTION = 'customers';
const REQUIRED = ['firstName', 'lastName', 'phone', 'status'];

// [field path, column span] per row. Markdown notes and the address get the full width.
const FORM_LAYOUT_ROWS = [
  [['firstName', 12], ['lastName', 12]],
  [['phone', 12], ['email', 12]],
  [['dateOfBirth', 12], ['status', 12]],
  [['skinProfile', 12], ['skinProfileOther', 12]],
  [['skinSensitivities', 12], ['skinSensitivitiesOther', 12]],
  [['address', 24]],
  [['notes', 24]],
];
const WANTED = FORM_LAYOUT_ROWS.flat().map(([path]) => path);

const fail = (what, result) => new Error(`${what} failed (${result.status}):\n${formatErrors(result.json)}`);

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

async function surface(client, uid) {
  const result = await client.request(`flowSurfaces:get?uid=${uid}`);
  if (!result.ok) throw fail(`flowSurfaces:get ${uid}`, result);
  return result.json.data.tree;
}

// Items that are on the form but not in the layout keep a full-width row at the end, so nothing disappears.
function layoutRows(itemsByPath) {
  const known = new Set(WANTED);
  const extras = Object.keys(itemsByPath).filter((path) => !known.has(path)).map((path) => [[path, 24]]);
  return [...FORM_LAYOUT_ROWS.filter((row) => row.every(([path]) => itemsByPath[path])), ...extras];
}

async function repairForm(client, formRef, check) {
  const form = findForms(await surface(client, formRef.uid)).find((node) => node.uid === formRef.uid);
  if (!form) throw new Error(`Form ${formRef.uid} not found in its surface`);
  const missing = missingFormFields(form, WANTED);
  const out = { form: formRef.use, uid: formRef.uid, added: missing, required: [] };
  if (check) return { ...out, dryRun: true };
  for (const path of missing) {
    const added = await client.request('flowSurfaces:addField', {
      method: 'POST',
      body: { target: { uid: form.uid }, fieldPath: path, settings: REQUIRED.includes(path) ? { required: true } : {} },
    });
    if (!added.ok) throw fail(`addField ${path} on ${form.uid}`, added);
  }
  const fresh = findForms(await surface(client, formRef.uid)).find((node) => node.uid === formRef.uid);
  const itemsByPath = formItemsByPath(fresh);
  const layout = await client.request('flowSurfaces:setLayout', {
    method: 'POST',
    body: { target: { uid: fresh.subModels.grid.uid }, ...formGridLayout(layoutRows(itemsByPath), itemsByPath) },
  });
  if (!layout.ok) throw fail(`setLayout on ${form.uid}`, layout);

  // Required marks on the core fields, same rule as apply-customer-required-fields.js.
  for (const item of fresh.subModels.grid.subModels.items || []) {
    const path = item.stepParams?.fieldSettings?.init?.fieldPath;
    if (!REQUIRED.includes(path) || item.props?.required === true) continue;
    const result = await client.request(`flowModels:update?filterByTk=${item.uid}`, { method: 'POST', body: { props: { ...(item.props || {}), required: true } } });
    if (!result.ok) throw fail(`mark ${path} required on ${form.uid}`, result);
    out.required.push(path);
  }
  return out;
}

async function main() {
  const check = process.argv.includes('--check');
  const client = await createClient();
  const forms = (await listAll(client)).filter((m) => /^(Create|Edit)FormModel$/.test(m.use) && m.stepParams?.resourceSettings?.init?.collectionName === COLLECTION);
  if (!forms.length) throw new Error('No customer create/edit forms found');
  const results = [];
  for (const form of forms) results.push(await repairForm(client, form, check));
  console.log(JSON.stringify({ status: 'ok', mode: check ? 'check' : 'apply', target: client.baseUrl, fields: WANTED, forms: results }, null, 2));
}

main().catch((error) => {
  console.error(`Customer forms apply failed: ${error.message}`);
  process.exitCode = 1;
});
