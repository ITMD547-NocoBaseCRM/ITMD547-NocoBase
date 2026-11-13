// Replaces the Staff field in every appointment create/edit form with the service-aware availability selector.
const fs = require('fs');
const path = require('path');
const { createClient, formatErrors, getSurface } = require('./nocobase-api');
const { findForms } = require('./appointments-page-layout');

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

async function updateForm(client, ref, check) {
  const tree = await getSurface(client, { uid: ref.uid });
  const form = findForms(tree).find((node) => node.uid === ref.uid);
  if (!form) throw new Error(`Appointment create form ${ref.uid} not found in its surface`);
  const current = staffItem(form);
  if (!current) return { form: ref.uid, changed: false, skipped: 'Staff field not present' };
  const field = Array.isArray(current?.subModels?.field) ? current.subModels.field[0] : current?.subModels?.field;
  const oldCode = field?.stepParams?.jsSettings?.runJs?.code;
  const replaceStaff = oldCode !== CODE;
  if (check) return { form: ref.uid, changed: replaceStaff, replaceStaff, dryRun: true };
  if (!replaceStaff) return { form: ref.uid, changed: false, status: 'up to date' };

  const originalGrid = form.subModels?.grid;
  const originalLayout = originalGrid?.props || {};
  if (!originalGrid?.uid || !originalLayout.rows || !originalLayout.sizes || !originalLayout.rowOrder) {
    throw new Error(`Appointment form ${ref.uid} has no restorable Staff grid layout`);
  }

  const removed = await client.request('flowSurfaces:removeNode', {
    method: 'POST',
    body: { target: { uid: current.uid } },
  });
  if (!removed.ok) throw fail(`remove existing Staff field on ${ref.uid}`, removed);

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

  const freshTree = await getSurface(client, { uid: ref.uid });
  const fresh = findForms(freshTree).find((node) => node.uid === ref.uid);
  if (!fresh) throw new Error(`Updated appointment create form ${ref.uid} not found`);
  const freshStaff = staffItem(fresh);
  if (!freshStaff) throw new Error(`Updated appointment form ${ref.uid} has no Staff field`);
  const validItems = new Set((fresh.subModels?.grid?.subModels?.items || []).map((item) => item.uid));
  const rows = {};
  const sizes = {};
  const rowOrder = [];
  for (const row of originalLayout.rowOrder) {
    const cells = originalLayout.rows[row] || [];
    const rowSizes = originalLayout.sizes[row] || [];
    const keptCells = [];
    const keptSizes = [];
    cells.forEach((cell, index) => {
      const kept = cell
        .map((uid) => uid === current.uid ? freshStaff.uid : uid)
        .filter((uid) => validItems.has(uid));
      if (kept.length) {
        keptCells.push(kept);
        keptSizes.push(rowSizes[index] || 24);
      }
    });
    if (keptCells.length) {
      rows[row] = keptCells;
      sizes[row] = keptSizes;
      rowOrder.push(row);
    }
  }
  const layout = await client.request('flowSurfaces:setLayout', {
    method: 'POST',
    body: {
      target: { uid: fresh.subModels.grid.uid },
      rows,
      sizes,
      rowOrder,
    },
  });
  if (!layout.ok) throw fail(`restore appointment form layout on ${ref.uid}`, layout);
  return { form: ref.uid, changed: true, layoutPreserved: true };
}

async function main() {
  const check = process.argv.includes('--check');
  const client = await createClient();
  const forms = (await listAll(client)).filter(
    (model) => /^(Create|Edit)FormModel$/.test(model.use)
      && model.stepParams?.resourceSettings?.init?.collectionName === 'appointments',
  );
  if (!forms.length) throw new Error('No appointment create/edit forms found');
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
