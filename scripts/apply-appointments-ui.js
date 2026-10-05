// Applies the Appointments page blueprint (US-26 / T-42) to the running NocoBase instance.
//
// Usage: yarn apply:appointments-ui [--page-schema-uid <uid>] [--layout-only | --forms-only]
//
// Requires the app to be running and the T-40 / T-42 metadata migrations to be applied and loaded.
// After the blueprint is written, the toolbar/table and the details/services blocks are stacked with
// `flowSurfaces:setLayout`. `--layout-only` skips the (slow) blueprint write and only re-arranges the
// live page, which is safe to repeat. `--forms-only` re-adds any field that is missing from the create and edit forms
// (for example after someone removed it in the page designer) and resets the form layout; it also takes seconds.

const {
  FORM_LAYOUT_ROWS,
  PAGE_SCHEMA_UID,
  REMOVED_FORM_FIELDS,
  buildAppointmentsPageBlueprint,
  formFields,
} = require('./appointments-page-blueprint');
const {
  findAppointmentsTable,
  findForms,
  formGridLayout,
  formItemsByPath,
  missingFormFields,
  findDetailsLayoutTarget,
  findPageLayoutTarget,
  findRowAction,
  stackedLayout,
} = require('./appointments-page-layout');
const { createClient, formatErrors, getSurface } = require('./nocobase-api');

function readArg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

async function setLayout(client, target) {
  const result = await client.request('flowSurfaces:setLayout', {
    method: 'POST',
    body: { target: { uid: target.gridUid }, ...stackedLayout(target.order) },
  });
  if (!result.ok) throw new Error(`setLayout failed (${result.status}):\n${formatErrors(result.json)}`);
}

// Stacks the page blocks and the View popup blocks. Returns the names of the grids it arranged.
async function arrangeLayout(client, pageSchemaUid) {
  const page = await getSurface(client, { pageSchemaUid });
  const pageTarget = findPageLayoutTarget(page);
  if (!pageTarget) throw new Error('The toolbar and the appointments table were not found on the page');
  await setLayout(client, pageTarget);
  const arranged = ['page'];

  const view = findRowAction(findAppointmentsTable(page), 'ViewActionModel');
  if (!view) throw new Error('The View row action was not found on the appointments table');
  const detailsTarget = findDetailsLayoutTarget(await getSurface(client, { uid: view.uid }));
  if (!detailsTarget) throw new Error('The details and booked services blocks were not found in the View popup');
  await setLayout(client, detailsTarget);
  arranged.push('view popup');
  return arranged;
}

// The three openers whose popups contain a create or edit form: New appointment, row Edit and View (its Edit).
function formOpeners(page) {
  const table = findAppointmentsTable(page);
  const addNew = (table?.subModels?.actions || []).find((action) => action.use === 'AddNewActionModel');
  return [addNew, findRowAction(table, 'EditActionModel'), findRowAction(table, 'ViewActionModel')].filter(Boolean);
}

// Brings the forms back to the blueprint: adds any field they are missing, removes the fields that were dropped on
// purpose (the derived appointment date), then resets each changed form to the blueprint layout.
async function repairForms(client, pageSchemaUid) {
  const wanted = FORM_LAYOUT_ROWS.flat().map(([path]) => path);
  const blueprintFields = Object.fromEntries(formFields().map((entry) => [entry.field, entry]));
  const page = await getSurface(client, { pageSchemaUid });
  const repaired = [];
  for (const opener of formOpeners(page)) {
    const popup = await getSurface(client, { uid: opener.uid });
    for (const form of findForms(popup)) {
      const missing = missingFormFields(form, wanted);
      const present = formItemsByPath(form);
      const removedItems = REMOVED_FORM_FIELDS.filter((path) => present[path]);
      if (!missing.length && !removedItems.length) continue;
      for (const path of removedItems) {
        const removed = await client.request('flowSurfaces:removeNode', {
          method: 'POST',
          body: { target: { uid: present[path] } },
        });
        if (!removed.ok)
          throw new Error(`removeNode ${path} failed (${removed.status}):
${formatErrors(removed.json)}`);
      }
      for (const path of missing) {
        const spec = blueprintFields[path] || { field: path };
        const settings = { ...(spec.settings || {}), ...(spec.titleField ? { titleField: spec.titleField } : {}) };
        const added = await client.request('flowSurfaces:addField', {
          method: 'POST',
          body: { target: { uid: form.uid }, fieldPath: path, settings },
        });
        if (!added.ok)
          throw new Error(`addField ${path} failed (${added.status}):
${formatErrors(added.json)}`);
      }
      const fresh = findForms(await getSurface(client, { uid: opener.uid })).find((node) => node.uid === form.uid);
      const result = await client.request('flowSurfaces:setLayout', {
        method: 'POST',
        body: {
          target: { uid: fresh.subModels.grid.uid },
          ...formGridLayout(FORM_LAYOUT_ROWS, formItemsByPath(fresh)),
        },
      });
      if (!result.ok)
        throw new Error(`setLayout failed (${result.status}):
${formatErrors(result.json)}`);
      repaired.push({ form: form.use, added: missing, removed: removedItems });
    }
  }
  return repaired;
}

async function main() {
  const pageSchemaUid = readArg('--page-schema-uid', PAGE_SCHEMA_UID);
  const layoutOnly = process.argv.includes('--layout-only');
  const formsOnly = process.argv.includes('--forms-only');
  const client = await createClient();

  if (formsOnly) {
    const repaired = await repairForms(client, pageSchemaUid);
    console.log(JSON.stringify({ status: 'ok', pageSchemaUid, formsRepaired: repaired }, null, 2));
    return;
  }

  if (!layoutOnly) {
    const blueprint = buildAppointmentsPageBlueprint({ pageSchemaUid });
    const result = await client.request('flowSurfaces:applyBlueprint', { method: 'POST', body: blueprint });
    if (!result.ok) {
      throw new Error(`applyBlueprint failed (${result.status}):\n${formatErrors(result.json)}`);
    }
  }
  const arranged = await arrangeLayout(client, pageSchemaUid);
  console.log(
    JSON.stringify(
      {
        status: 'ok',
        pageSchemaUid,
        blueprint: layoutOnly ? 'skipped' : 'applied',
        arranged,
        url: `/admin/${pageSchemaUid}`,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(`Appointments UI apply failed: ${error.message}`);
  process.exitCode = 1;
});
