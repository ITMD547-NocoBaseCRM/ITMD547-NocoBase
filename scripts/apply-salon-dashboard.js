// Creates/updates the responsive Salon Dashboard in desktop and mobile navigation.
const fs = require('fs');
const path = require('path');
const { createClient, formatErrors, getSurface } = require('./nocobase-api');

const TITLE = 'Dashboard';
const GROUP = 'BeautyWithin Portal';
const CODE = fs.readFileSync(path.join(__dirname, 'ui', 'salon-dashboard.js'), 'utf8');
const MOBILE_HTML = fs.readFileSync(path.join(__dirname, 'ui', 'salon-mobile-dashboard.html'), 'utf8');
const MOBILE_SCHEMA_UID = 'salondashm01';
const MOBILE_IFRAME_UID = 'salondashflw';
const MOBILE_MARKER = '<h1>Today</h1>';
const fail = (what, result) => new Error(`${what} failed (${result.status}):\n${formatErrors(result.json)}`);

async function routes(client, resource) {
  const result = await client.request(`${resource}:list?paginate=false&fields=id,title,type,schemaUid,parentId,sort,icon,options,enableTabs`);
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

function mobilePageSchema(iframeHtmlId) {
  return {
    type: 'void', name: MOBILE_SCHEMA_UID, 'x-uid': MOBILE_SCHEMA_UID,
    'x-component': 'MobilePageProvider', 'x-settings': 'mobile:page', 'x-decorator': 'BlockItem',
    'x-decorator-props': { style: { height: '100%' } }, 'x-toolbar-props': { draggable: false },
    'x-component-props': { displayTabs: false },
    properties: {
      header: {
        type: 'void', 'x-component': 'MobilePageHeader', 'x-uid': 'salondashhdr',
        properties: { pageNavigationBar: { type: 'void', 'x-component': 'MobilePageNavigationBar', 'x-uid': 'salondashnav' } },
      },
      content: {
        type: 'void', 'x-component': 'MobilePageContent', 'x-uid': 'salondashcnt',
        properties: {
          grid: {
            type: 'void', 'x-uid': 'salondashgrd', 'x-component': 'Grid', 'x-component-props': { showDivider: false },
            properties: {
              row: {
                type: 'void', 'x-uid': 'salondashrow', 'x-component': 'Grid.Row',
                properties: {
                  col: {
                    type: 'void', 'x-uid': 'salondashcol', 'x-component': 'Grid.Col',
                    properties: {
                      dashboard: {
                        type: 'void', 'x-uid': MOBILE_IFRAME_UID, 'x-decorator': 'BlockItem',
                        'x-decorator-props': { name: 'iframe' }, 'x-settings': 'blockSettings:iframe', 'x-component': 'Iframe',
                        'x-component-props': { mode: 'html', htmlId: iframeHtmlId, engine: 'string', height: 'calc(100vh - 100px)' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  };
}

async function ensureMobileDashboardSchema(client) {
  const htmlList = await client.request('iframeHtml:list?paginate=false');
  if (!htmlList.ok) throw fail('list mobile Dashboard HTML documents', htmlList);
  let htmlRecord = (htmlList.json?.data || []).find((item) => String(item.html || '').includes(MOBILE_MARKER));
  if (!htmlRecord) {
    const created = await client.request('iframeHtml:create', { method: 'POST', body: { html: MOBILE_HTML } });
    if (!created.ok) throw fail('create mobile Dashboard HTML document', created);
    htmlRecord = created.json?.data;
  } else if (htmlRecord.html !== MOBILE_HTML) {
    const updated = await client.request(`iframeHtml:update?filterByTk=${htmlRecord.id}`, { method: 'POST', body: { html: MOBILE_HTML } });
    if (!updated.ok) throw fail('update mobile Dashboard HTML document', updated);
  }
  if (!htmlRecord?.id) throw new Error('Mobile Dashboard HTML document returned no id');

  const current = await client.request(`uiSchemas:getJsonSchema/${MOBILE_SCHEMA_UID}`);
  if (!current.ok) throw fail('read mobile Dashboard schema', current);
  const currentSchema = current.json?.data;
  const hasGrid = currentSchema?.properties?.content?.properties?.grid?.['x-component'] === 'Grid';
  if (currentSchema?.['x-uid'] && !hasGrid) {
    const removed = await client.request(`uiSchemas:remove/${MOBILE_SCHEMA_UID}`, { method: 'POST' });
    if (!removed.ok) throw fail('replace obsolete mobile Dashboard schema', removed);
  }
  if (!currentSchema?.['x-uid'] || !hasGrid) {
    const inserted = await client.request('uiSchemas:insert', { method: 'POST', body: mobilePageSchema(htmlRecord.id) });
    if (!inserted.ok) throw fail('create mobile Dashboard schema', inserted);
  } else {
    const patched = await client.request('uiSchemas:patch', {
      method: 'POST',
      body: {
        'x-uid': MOBILE_IFRAME_UID,
        'x-component': 'Iframe',
        'x-component-props': { mode: 'html', htmlId: htmlRecord.id, engine: 'string', height: 'calc(100vh - 100px)' },
      },
    });
    if (!patched.ok) throw fail('update mobile Dashboard schema', patched);
  }
  return { schemaUid: MOBILE_SCHEMA_UID, htmlId: htmlRecord.id };
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
  const rolesResult = await client.request('roles:list?paginate=false&appends=mobileRoutes&fields=name,title');
  if (!rolesResult.ok) throw fail('list roles for mobile Dashboard access', rolesResult);
  const roles = rolesResult.json?.data || [];
  const rolesWithMobileAccess = roles.filter((role) =>
    role.name !== 'root' && (role.mobileRoutes || []).some((route) => route.parentId == null),
  );
  const missingRoles = page
    ? rolesWithMobileAccess.filter((role) => !(role.mobileRoutes || []).some((route) => route.id === page.id))
    : rolesWithMobileAccess;
  if (check) return {
    layout: 'mobile-layout-model',
    status: page ? 'present' : 'missing',
    pageSchemaUid: page?.schemaUid,
    missingRoles: missingRoles.map((role) => role.name),
    changed: !page || page.schemaUid !== MOBILE_SCHEMA_UID || Number(page.sort) !== 0 || missingRoles.length > 0,
  };
  const mobileDashboard = await ensureMobileDashboardSchema(client);
  let dashboard = page;
  if (!page) {
    const result = await client.request('mobileRoutes:create', {
      method: 'POST',
      body: { title: TITLE, type: 'page', schemaUid: mobileDashboard.schemaUid, icon: 'DashboardOutlined', sort: 0, enableTabs: false, options: { flowSurfaceMenuBindable: true } },
    });
    if (!result.ok) throw fail('create mobile Dashboard route', result);
    dashboard = result.json?.data;
  } else if (page.schemaUid !== mobileDashboard.schemaUid || Number(page.sort) !== 0 || page.enableTabs !== false) {
    const result = await client.request(`mobileRoutes:update?filterByTk=${page.id}`, { method: 'POST', body: { schemaUid: mobileDashboard.schemaUid, sort: 0, icon: 'DashboardOutlined', enableTabs: false } });
    if (!result.ok) throw fail('link mobile Dashboard route', result);
  }
  if (!dashboard?.id) {
    const refreshed = await routes(client, 'mobileRoutes');
    dashboard = refreshed.find((route) => route.title === TITLE && route.type === 'page');
  }
  for (const role of missingRoles) {
    const result = await client.request(`roles/${encodeURIComponent(role.name)}/mobileRoutes:add`, {
      method: 'POST',
      body: { tk: dashboard.id },
    });
    if (!result.ok) throw fail(`grant mobile Dashboard to role ${role.name}`, result);
  }
  return {
    layout: 'mobile-layout-model',
    status: 'ready',
    pageSchemaUid: mobileDashboard.schemaUid,
    desktopPageSchemaUid: pageSchemaUid,
    iframeHtmlId: mobileDashboard.htmlId,
    grantedRoles: missingRoles.map((role) => role.name),
    changed: !page || page.schemaUid !== mobileDashboard.schemaUid || Number(page.sort) !== 0 || missingRoles.length > 0,
  };
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
