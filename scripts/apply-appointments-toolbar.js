// Updates only the toolbar script of the live Appointments page (US-26 / T-43).
//
// Usage: yarn apply:appointments-toolbar [--page-schema-uid <uid>]
//
// Re-authoring the whole page takes minutes and regenerates every block uid. The toolbar is a JS block, so
// its code can be replaced in place with `flowSurfaces:configure`, which takes seconds and leaves the
// table, popups and layout untouched. The code is the same script the page blueprint embeds.

const { PAGE_SCHEMA_UID, readToolbarScript } = require('./appointments-page-blueprint');
const { createClient, formatErrors, getSurface } = require('./nocobase-api');
const { findNode, findPageLayoutTarget } = require('./appointments-page-layout');

function readArg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

async function main() {
  const pageSchemaUid = readArg('--page-schema-uid', PAGE_SCHEMA_UID);
  const client = await createClient();
  const page = await getSurface(client, { pageSchemaUid });
  const target = findPageLayoutTarget(page);
  if (!target) throw new Error('The toolbar and the appointments table were not found on the page');
  const toolbarUid = target.order[0];
  const toolbar = findNode(page, (node) => node.uid === toolbarUid);
  if (!toolbar || toolbar.use !== 'JSBlockModel') throw new Error('The toolbar block is not a JS block');

  const code = readToolbarScript();
  const current = toolbar.stepParams?.jsSettings?.runJs?.code;
  if (current === code) {
    console.log(JSON.stringify({ status: 'ok', toolbar: toolbarUid, changed: false }, null, 2));
    return;
  }
  const result = await client.request('flowSurfaces:configure', {
    method: 'POST',
    body: { target: { uid: toolbarUid }, changes: { version: 'v2', code } },
  });
  if (!result.ok) throw new Error(`configure failed (${result.status}):\n${formatErrors(result.json)}`);
  console.log(JSON.stringify({ status: 'ok', toolbar: toolbarUid, changed: true, bytes: code.length }, null, 2));
}

main().catch((error) => {
  console.error(`Appointments toolbar apply failed: ${error.message}`);
  process.exitCode = 1;
});
