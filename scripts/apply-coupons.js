// Applies the coupons feature to the running NocoBase instance.
//
// Usage: yarn apply:coupons [--check]
//
// Idempotent, in order:
//   1. creates the `coupons` collection (code, discount, scope, validity, limits) if missing;
//   2. creates the `couponRedemptions` collection (usage tracking) if missing;
//   3. ensures the "Offers" page in the left nav with a "Coupons" tab (and removes the old
//      Coupons tab from the Messages page if one is still there);
//   4. puts the coupons UI (scripts/ui/coupons-tab.js) in that tab as a JS block, or updates its
//      code in place when it changed.
//
// --check reports what would change and writes nothing.

const fs = require('fs');
const path = require('path');
const { createClient, formatErrors } = require('./nocobase-api');
const {
  COUPONS_COLLECTION,
  COUPONS_TAB_TITLE,
  REDEMPTIONS_COLLECTION,
  couponsCollectionDefinition,
  redemptionsCollectionDefinition,
} = require('./coupons');

const OFFERS_PAGE_TITLE = 'Offers';
const MENU_GROUP_TITLE = 'Beauty Within Portal';
const OLD_PAGE_TITLE = 'Messages'; // the tab lived here before the Offers page existed
const TAB_ICON = 'TagsOutlined';
const TAB_CODE = fs.readFileSync(path.join(__dirname, 'ui', 'coupons-tab.js'), 'utf8');

const fail = (what, result) => new Error(`${what} failed (${result.status}):\n${formatErrors(result.json)}`);

// ─── Collection helpers (same pattern as apply-appointment-reminders.js) ─────

async function ensureCollection(client, check, collectionName, definition) {
  const existing = await client.request(`collections:get?filterByTk=${collectionName}`);
  if (existing.ok && existing.json?.data?.name === collectionName) return 'present';
  if (check) return 'missing';
  const created = await client.request('collections:create', { method: 'POST', body: definition });
  if (!created.ok) throw fail(`collections:create ${collectionName}`, created);
  return 'created';
}

async function ensureFields(client, check, collectionName, definition) {
  const list = await client.request(`collections/${collectionName}/fields:list?paginate=false`);
  if (!list.ok) throw fail(`fields:list ${collectionName}`, list);
  const present = new Set((list.json?.data || []).map((f) => f.name));
  const out = { present: [], created: [] };
  for (const field of definition.fields) {
    if (present.has(field.name)) { out.present.push(field.name); continue; }
    if (check) { out.created.push(`${field.name} (dry run)`); continue; }
    const created = await client.request(`collections/${collectionName}/fields:create`, { method: 'POST', body: field });
    if (!created.ok) throw fail(`fields:create ${collectionName}.${field.name}`, created);
    out.created.push(field.name);
  }
  return out;
}

// ─── Tree helpers ────────────────────────────────────────────────────────────

function* walk(node) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const item of node) yield* walk(item); return; }
  if (node.uid && node.use) yield node;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'stepParams' || key === 'props') continue;
    yield* walk(value);
  }
}
const findAll = (root, pred) => { const out = []; for (const n of walk(root)) if (pred(n)) out.push(n); return out; };

function getRunJsCode(node) {
  const seen = new Set();
  const search = (value) => {
    if (!value || typeof value !== 'object' || seen.has(value)) return undefined;
    seen.add(value);
    if (typeof value.code === 'string') return value.code;
    for (const child of Object.values(value)) {
      const found = search(child);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return search(node.stepParams);
}

async function surface(client, pageSchemaUid) {
  const result = await client.request(`flowSurfaces:get?pageSchemaUid=${pageSchemaUid}`);
  if (!result.ok) throw fail(`flowSurfaces:get ${pageSchemaUid}`, result);
  return result.json?.data;
}

// ─── Coupons tab on the Offers page (left nav) ───────────────────────────────
// Creates the Offers page when missing (first of apply-coupons / apply-promo-games to run
// creates it; the other adds its tab), ensures the Coupons tab with the JS block, and removes
// the old Coupons tab from the Messages page if one is still there.

async function ensureCouponsTab(client, check) {
  const routes = await client.request('desktopRoutes:list?paginate=false&fields=id,title,type,schemaUid,parentId');
  if (!routes.ok) throw fail('desktopRoutes:list', routes);
  const rows = routes.json?.data || [];
  const out = {};

  let page = rows.find((r) => r.type === 'flowPage' && r.title === OFFERS_PAGE_TITLE);
  let pageSchemaUid = page?.schemaUid;
  if (!pageSchemaUid) {
    if (check) return { status: `page "${OFFERS_PAGE_TITLE}" missing: would create page + tab + JS block` };
    const group = rows.find((r) => r.title === MENU_GROUP_TITLE && r.type === 'group');
    const created = await client.request('flowSurfaces:createPage', {
      method: 'POST',
      body: { title: OFFERS_PAGE_TITLE, icon: 'GiftOutlined', parentMenuRouteId: group ? group.id : undefined, displayTitle: true, enableTabs: true, tabTitle: COUPONS_TAB_TITLE },
    });
    if (!created.ok) throw fail('flowSurfaces:createPage (Offers)', created);
    const data = created.json?.data || {};
    pageSchemaUid = data.pageSchemaUid || data.schemaUid || data.route?.schemaUid;
    if (!pageSchemaUid) throw new Error(`createPage returned no pageSchemaUid: ${JSON.stringify(data).slice(0, 300)}`);
    out.page = 'created';
  } else {
    out.page = 'present';
  }

  let root = await surface(client, pageSchemaUid);
  let tab = findAll(root, (n) => n.use === 'RootPageTabModel' && n.stepParams?.pageTabSettings?.tab?.title === COUPONS_TAB_TITLE)[0];
  if (!tab) {
    if (check) return { ...out, status: 'tab missing: would add tab + JS block' };
    const pageRoot = findAll(root, (n) => n.use === 'RootPageModel')[0];
    const added = await client.request('flowSurfaces:addTab', {
      method: 'POST',
      body: { target: { uid: pageRoot ? pageRoot.uid : pageSchemaUid }, title: COUPONS_TAB_TITLE, icon: TAB_ICON },
    });
    if (!added.ok) throw fail('flowSurfaces:addTab (Coupons)', added);
    root = await surface(client, pageSchemaUid);
    tab = findAll(root, (n) => n.use === 'RootPageTabModel' && n.stepParams?.pageTabSettings?.tab?.title === COUPONS_TAB_TITLE)[0];
    if (!tab) throw new Error('Coupons tab not found after addTab');
    out.tab = 'created';
  } else {
    out.tab = 'present';
  }

  const grid = findAll(tab, (n) => n.use === 'BlockGridModel')[0];
  if (!grid) return { ...out, status: 'tab has no block grid: skipped' };

  const jsBlock = findAll(grid, (n) => n.use === 'JSBlockModel')[0];
  if (jsBlock) {
    if (getRunJsCode(jsBlock) === TAB_CODE) out.status = 'present';
    else if (check) out.status = 'would update code';
    else {
      const result = await client.request('flowSurfaces:configure', {
        method: 'POST',
        body: { target: { uid: jsBlock.uid }, changes: { version: 'v2', code: TAB_CODE } },
      });
      if (!result.ok) throw fail('flowSurfaces:configure (Coupons tab)', result);
      out.status = 'code updated';
    }
    out.uid = jsBlock.uid;
  } else if (check) {
    out.status = 'would add JS block';
  } else {
    const added = await client.request('flowSurfaces:addBlock', {
      method: 'POST',
      body: { target: { uid: grid.uid }, type: 'jsBlock', settings: { code: TAB_CODE, version: '1.0.0' } },
    });
    if (!added.ok) throw fail('flowSurfaces:addBlock (Coupons tab)', added);
    out.status = 'created';
  }

  // Migration: drop the old Coupons tab from the Messages page once the Offers one is in place.
  const oldPage = rows.find((r) => r.type === 'flowPage' && r.title === OLD_PAGE_TITLE);
  const oldTab = oldPage && rows.find((r) => r.type === 'tabs' && r.title === COUPONS_TAB_TITLE && r.parentId === oldPage.id);
  if (oldTab) {
    if (check) out.oldMessagesTab = 'would remove';
    else {
      const removed = await client.request('flowSurfaces:removeTab', { method: 'POST', body: { uid: oldTab.schemaUid } });
      if (!removed.ok) throw fail('flowSurfaces:removeTab (old Coupons tab on Messages)', removed);
      out.oldMessagesTab = 'removed';
    }
  }
  return out;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const check = process.argv.includes('--check');
  const client = await createClient();
  const summary = { status: 'ok', mode: check ? 'check' : 'apply', target: client.baseUrl };

  const couponsDef = couponsCollectionDefinition();
  const redemptionsDef = redemptionsCollectionDefinition();
  summary.couponsCollection = await ensureCollection(client, check, COUPONS_COLLECTION, couponsDef);
  if (summary.couponsCollection !== 'missing') summary.couponsFields = await ensureFields(client, check, COUPONS_COLLECTION, couponsDef);
  summary.redemptionsCollection = await ensureCollection(client, check, REDEMPTIONS_COLLECTION, redemptionsDef);
  if (summary.redemptionsCollection !== 'missing') summary.redemptionsFields = await ensureFields(client, check, REDEMPTIONS_COLLECTION, redemptionsDef);

  summary.couponsTab = await ensureCouponsTab(client, check);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(`Coupons apply failed: ${error.message}`);
  process.exitCode = 1;
});
