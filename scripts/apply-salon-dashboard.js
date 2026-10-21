// Creates/updates the responsive Salon Dashboard in desktop and mobile navigation.
const fs = require('fs');
const path = require('path');
const { createClient, formatErrors, getSurface } = require('./nocobase-api');

const TITLE = 'Dashboard';
const GROUP = 'BeautyWithin Portal';
const CODE = fs.readFileSync(path.join(__dirname, 'ui', 'salon-dashboard.js'), 'utf8');
const fail = (what, result) => new Error(`${what} failed (${result.status}):\n${formatErrors(result.json)}`);

async function routes(client, resource) {
  const result = await client.request(`${resource}:list?paginate=false&fields=id,title,type,schemaUid,parentId`);
  if (!result.ok) throw fail(`list ${resource}`, result);
  return result.json?.data || [];
}

function findJs(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.use === 'JSBlockModel') return node;
  for (const value of Object.values(node)) {
    const found = findJs(value);
    if (found) return found;
  }
  return null;
}

function findGrid(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.use === 'BlockGridModel') return node;
  for (const value of Object.values(node)) {
    const found = findGrid(value);
    if (found) return found;
  }
  return null;
}

async function ensureDesktopPage(client, { parentMenuRouteId, check }) {
  const all = await routes(client, 'desktopRoutes');
  const matches = all.filter((route) => route.title === TITLE && route.type === 'flowPage');
  let page = matches.find((route) => route.parentId === parentMenuRouteId) || matches[0];
  if (!page && check) return { layout: 'admin-layout-model', status: 'missing', changed: true };
  if (!page) {
    const result = await client.request('flowSurfaces:createPage', {
      method: 'POST',
      body: { title: TITLE, icon: 'DashboardOutlined', displayTitle: false, parentMenuRouteId },
    });
    if (!result.ok) throw fail('create desktop Dashboard', result);
    const data = result.json?.data || {};
    page = { schemaUid: data.pageSchemaUid || data.schemaUid || data.route?.schemaUid };
    if (!page.schemaUid) throw new Error('createPage returned no schema UID for desktop Dashboard');
  }

  const tree = await getSurface(client, { pageSchemaUid: page.schemaUid });
  const existing = findJs(tree);
  const current = existing?.stepParams?.jsSettings?.runJs?.code;
  if (check) return { layout: 'admin-layout-model', status: existing ? 'present' : 'empty', pageSchemaUid: page.schemaUid, changed: current !== CODE || matches.length > 1 };
  if (existing && current !== CODE) {
    const result = await client.request('flowSurfaces:configure', {
      method: 'POST', body: { target: { uid: existing.uid }, changes: { version: 'v2', code: CODE } },
    });
    if (!result.ok) throw fail('update desktop dashboard', result);
  } else if (!existing) {
    const grid = findGrid(tree);
    if (!grid) throw new Error('No block grid found on desktop Dashboard');
    const result = await client.request('flowSurfaces:addBlock', {
      method: 'POST',
      body: { target: { uid: grid.uid }, type: 'jsBlock', settings: { title: 'Daily salon overview', version: 'v2', code: CODE } },
    });
    if (!result.ok) throw fail('add desktop dashboard block', result);
  }
  for (const duplicate of matches.filter((route) => route.id !== page.id)) {
    const removed = await client.request(`desktopRoutes:destroy?filterByTk=${duplicate.id}`, { method: 'POST' });
    if (!removed.ok) throw fail(`remove duplicate Dashboard route ${duplicate.id}`, removed);
  }
  return { layout: 'admin-layout-model', status: 'ready', pageSchemaUid: page.schemaUid, changed: !existing || current !== CODE || matches.length > 1 };
}

async function ensureMobileRoute(client, pageSchemaUid, check) {
  const all = await routes(client, 'mobileRoutes');
  const page = all.find((route) => route.title === TITLE && route.type === 'page');
  if (check) return { layout: 'mobile-layout-model', status: page ? 'present' : 'missing', pageSchemaUid: page?.schemaUid, changed: !page || page.schemaUid !== pageSchemaUid };
  if (!page) {
    const result = await client.request('mobileRoutes:create', {
      method: 'POST',
      body: { title: TITLE, type: 'page', schemaUid: pageSchemaUid, icon: 'DashboardOutlined', options: { flowSurfaceMenuBindable: true } },
    });
    if (!result.ok) throw fail('create mobile Dashboard route', result);
  } else if (page.schemaUid !== pageSchemaUid) {
    const result = await client.request(`mobileRoutes:update?filterByTk=${page.id}`, { method: 'POST', body: { schemaUid: pageSchemaUid } });
    if (!result.ok) throw fail('link mobile Dashboard route', result);
  }
  return { layout: 'mobile-layout-model', status: 'ready', pageSchemaUid, changed: !page || page.schemaUid !== pageSchemaUid };
}

async function main() {
  const check = process.argv.includes('--check');
  const client = await createClient();
  const desktop = await routes(client, 'desktopRoutes');
  const group = desktop.find((route) => route.title === GROUP && route.type === 'group');
  const results = [];
  const desktopPage = await ensureDesktopPage(client, { parentMenuRouteId: group?.id, check });
  results.push(desktopPage);
  if (desktopPage.pageSchemaUid) results.push(await ensureMobileRoute(client, desktopPage.pageSchemaUid, check));
  console.log(JSON.stringify({ status: 'ok', mode: check ? 'check' : 'apply', target: client.baseUrl, pages: results }, null, 2));
}

main().catch((error) => {
  console.error(`Salon dashboard apply failed: ${error.message}`);
  process.exitCode = 1;
});
