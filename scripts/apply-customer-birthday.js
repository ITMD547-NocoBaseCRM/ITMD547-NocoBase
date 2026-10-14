// Replaces the date-of-birth calendar on the customer create and edit forms with month / day / year dropdowns
// (scripts/ui/customer-birthday.js, an editable JS field bound to customers.dateOfBirth).
//
// Usage: yarn apply:customer-birthday [--check]
//
// Idempotent: a form whose date-of-birth item already runs the current script is left alone; otherwise the old item
// is removed, the JS one is added, and the form layout is restored by apply-customer-forms.js. Same credentials and
// target rules as the other apply scripts (.env, NOCOBASE_API_URL).

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { createClient, formatErrors } = require('./nocobase-api');
const { findForms } = require('./appointments-page-layout');

const COLLECTION = 'customers';
const FIELD = 'dateOfBirth';
const LABEL = 'Date of birth';
const SCRIPT_PATH = path.join(__dirname, 'ui', 'customer-birthday.js');

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

// The form item that shows the field, and whether it is already the JS picker with the current code.
function birthdayItem(form) {
  const items = form?.subModels?.grid?.subModels?.items || [];
  const item = items.find((it) => it?.stepParams?.fieldSettings?.init?.fieldPath === FIELD);
  if (!item) return null;
  const field = item.subModels?.field;
  const fieldModel = Array.isArray(field) ? field[0] : field;
  const code = fieldModel?.stepParams?.jsSettings?.runJs?.code;
  return { uid: item.uid, isJs: !!code, code };
}

async function main() {
  const check = process.argv.includes('--check');
  const code = fs.readFileSync(SCRIPT_PATH, 'utf8');
  const client = await createClient();
  const forms = (await listAll(client)).filter((m) => /^(Create|Edit)FormModel$/.test(m.use) && m.stepParams?.resourceSettings?.init?.collectionName === COLLECTION);
  if (!forms.length) throw new Error('No customer create/edit forms found');
  const results = [];
  let changed = false;
  for (const ref of forms) {
    const form = findForms(await surface(client, ref.uid)).find((node) => node.uid === ref.uid);
    const current = birthdayItem(form);
    if (current && current.isJs && current.code === code) { results.push({ form: ref.use, uid: ref.uid, status: 'up to date' }); continue; }
    if (check) { results.push({ form: ref.use, uid: ref.uid, status: current ? (current.isJs ? 'script outdated (would replace)' : 'calendar (would replace)') : 'missing (would add)' }); continue; }
    if (current) {
      const removed = await client.request('flowSurfaces:removeNode', { method: 'POST', body: { target: { uid: current.uid } } });
      if (!removed.ok) throw fail(`removeNode ${FIELD} on ${ref.uid}`, removed);
    }
    const added = await client.request('flowSurfaces:addField', {
      method: 'POST',
      body: { target: { uid: ref.uid }, fieldPath: FIELD, renderer: 'js', settings: { label: LABEL, version: 'v2', code } },
    });
    if (!added.ok) throw fail(`addField js ${FIELD} on ${ref.uid}`, added);
    changed = true;
    results.push({ form: ref.use, uid: ref.uid, status: current ? 'replaced' : 'added' });
  }
  let layout = 'unchanged';
  if (changed) {
    const run = spawnSync(process.execPath, [require.resolve('./apply-customer-forms')], { encoding: 'utf8', env: process.env });
    if (run.status !== 0) throw new Error(`form layout restore failed:\n${run.stderr || run.stdout}`);
    layout = 'restored';
  }
  console.log(JSON.stringify({ status: 'ok', mode: check ? 'check' : 'apply', target: client.baseUrl, forms: results, layout }, null, 2));
}

main().catch((error) => {
  console.error(`Customer birthday picker apply failed: ${error.message}`);
  process.exitCode = 1;
});
