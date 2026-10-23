// Replaces the Staff field in every New appointment form (List and Calendar quick-create)
// with the availability-aware JS selector.
const fs = require('fs');
const path = require('path');
const { createClient, formatErrors, getSurface } = require('./nocobase-api');
const { FORM_LAYOUT_ROWS, REMOVED_FORM_FIELDS, formFields } = require('./appointments-page-blueprint');
const { findForms, formItemsByPath, missingFormFields } = require('./appointments-page-layout');

const CODE = fs.readFileSync(path.join(__dirname, 'ui', 'appointment-available-staff.js'), 'utf8');
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

function staffItem(form) {
  return (form?.subModels?.grid?.subModels?.items || []).find(
    (item) => item?.stepParams?.fieldSettings?.init?.fieldPath === 'staff',
  );
}

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

async function updateForm(client, ref, check) {
  const tree = await getSurface(client, { uid: ref.uid });
  const form = findForms(tree).find((node) => node.uid === ref.uid);
  if (!form) throw new Error(`Appointment create form ${ref.uid} not found in its surface`);
  const current = staffItem(form);
  const field = Array.isArray(current?.subModels?.field) ? current.subModels.field[0] : current?.subModels?.field;
  const oldCode = field?.stepParams?.jsSettings?.runJs?.code;
  const wanted = FORM_LAYOUT_ROWS.flat().map(([fieldPath]) => fieldPath);
  const present = formItemsByPath(form);
  const missing = missingFormFields(form, wanted).filter((fieldPath) => fieldPath !== 'staff');
  const removed = REMOVED_FORM_FIELDS.filter((fieldPath) => present[fieldPath]);
  const replaceStaff = oldCode !== CODE;
  if (check) return {
    form: ref.uid,
    changed: replaceStaff || missing.length > 0 || removed.length > 0,
    replaceStaff,
    missing,
    removed,
    dryRun: true,
  };

  for (const fieldPath of removed) {
    const result = await client.request('flowSurfaces:removeNode', {
      method: 'POST',
      body: { target: { uid: present[fieldPath] } },
    });
    if (!result.ok) throw fail(`remove ${fieldPath} on ${ref.uid}`, result);
  }
  const specs = Object.fromEntries(formFields().map((spec) => [spec.field, spec]));
  for (const fieldPath of missing) {
    const spec = specs[fieldPath] || { field: fieldPath };
    const settings = { ...(spec.settings || {}), ...(spec.titleField ? { titleField: spec.titleField } : {}) };
    const result = await client.request('flowSurfaces:addField', {
      method: 'POST',
      body: { target: { uid: form.uid }, fieldPath, settings },
    });
    if (!result.ok) throw fail(`add ${fieldPath} on ${ref.uid}`, result);
  }
  if (replaceStaff) {
    if (current) {
      const result = await client.request('flowSurfaces:removeNode', {
        method: 'POST',
        body: { target: { uid: current.uid } },
      });
      if (!result.ok) throw fail(`remove existing Staff field on ${ref.uid}`, result);
    }
    const added = await client.request('flowSurfaces:addField', {
      method: 'POST',
      body: {
        target: { uid: form.uid },
        fieldPath: 'staff',
        renderer: 'js',
        settings: { label: 'Staff', version: 'v2', code: CODE },
      },
    });
    if (!added.ok) throw fail(`add availability-aware Staff field on ${ref.uid}`, added);
  }

  const freshTree = await getSurface(client, { uid: ref.uid });
  const fresh = findForms(freshTree).find((node) => node.uid === ref.uid);
  if (!fresh) throw new Error(`Updated appointment create form ${ref.uid} not found`);
  const layout = await client.request('flowSurfaces:setLayout', {
    method: 'POST',
    body: { target: { uid: fresh.subModels.grid.uid }, ...completeFormLayout(fresh) },
  });
  if (!layout.ok) throw fail(`restore New appointment form layout on ${ref.uid}`, layout);
  return { form: ref.uid, changed: replaceStaff || missing.length > 0 || removed.length > 0, layoutAligned: true };
}

async function main() {
  const check = process.argv.includes('--check');
  const client = await createClient();
  const forms = (await listAll(client)).filter(
    (model) => model.use === 'CreateFormModel'
      && model.stepParams?.resourceSettings?.init?.collectionName === 'appointments',
  );
  if (!forms.length) throw new Error('No appointment create forms found');
  const results = [];
  for (const form of forms) results.push(await updateForm(client, form, check));
  console.log(JSON.stringify({
    status: 'ok',
    mode: check ? 'check' : 'apply',
    target: client.baseUrl,
    forms: results,
  }, null, 2));
}

main().catch((error) => {
  console.error(`Appointment staff availability apply failed: ${error.message}`);
  process.exitCode = 1;
});
