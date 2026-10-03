// Applies the Appointments page blueprint (US-26 / T-42) to the running NocoBase instance.
//
// Usage: yarn apply:appointments-ui [--page-schema-uid <uid>] [--layout-only]
//
// Requires the app to be running and the T-40 / T-42 metadata migrations to be applied and loaded.
// After the blueprint is written, the toolbar/table and the details/services blocks are stacked with
// `flowSurfaces:setLayout`. `--layout-only` skips the (slow) blueprint write and only re-arranges the
// live page, which is safe to repeat.

const { buildAppointmentsPageBlueprint, PAGE_SCHEMA_UID } = require('./appointments-page-blueprint');
const {
  findAppointmentsTable,
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

async function main() {
  const pageSchemaUid = readArg('--page-schema-uid', PAGE_SCHEMA_UID);
  const layoutOnly = process.argv.includes('--layout-only');
  const client = await createClient();

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
