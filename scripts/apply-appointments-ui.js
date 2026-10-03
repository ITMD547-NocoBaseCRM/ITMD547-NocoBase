// Applies the Appointments page blueprint (US-26 / T-42) to the running NocoBase instance.
//
// Usage: yarn apply:appointments-ui [--page-schema-uid <uid>]
// Requires the app to be running and the T-40 / T-42 metadata migrations to be applied and loaded.

const { buildAppointmentsPageBlueprint, PAGE_SCHEMA_UID } = require('./appointments-page-blueprint');
const { createClient, formatErrors } = require('./nocobase-api');

function readArg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

async function main() {
  const pageSchemaUid = readArg('--page-schema-uid', PAGE_SCHEMA_UID);
  const blueprint = buildAppointmentsPageBlueprint({ pageSchemaUid });
  const client = await createClient();
  const result = await client.request('flowSurfaces:applyBlueprint', { method: 'POST', body: blueprint });
  if (!result.ok) {
    throw new Error(`applyBlueprint failed (${result.status}):\n${formatErrors(result.json)}`);
  }
  const data = result.json?.data || {};
  console.log(
    JSON.stringify(
      {
        status: 'ok',
        pageSchemaUid: data.pageSchemaUid || pageSchemaUid,
        mode: blueprint.mode,
        url: `/admin/${data.pageSchemaUid || pageSchemaUid}`,
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
