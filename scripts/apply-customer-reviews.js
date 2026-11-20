// Applies T-05 customer reviews to the running NocoBase instance.
//
// Usage: yarn apply:customer-reviews [--check] [--keep-workflow-disabled] [--remove-statistics]
//
// Prerequisite: the plugin is enabled (yarn pm enable @salon/plugin-customer-reviews). It owns the collections,
// the public review page, the secure actions and the "Send review invitations" workflow node.
//
// Idempotent, in order:
//   1. checks the plugin and reports the Email notification channel the review emails will use;
//   2. creates (or updates) and enables the workflow "Customer reviews: invite after completed appointment":
//      collection event on appointments, after update, changed field status, condition status = completed,
//      one node "Send review invitations";
//   3. adds the "Review invitations" panel (scripts/ui/appointment-review-invitations.js) to every Appointment
//      details drawer, or refreshes its code;
//   4. adds a "Customer Reviews" tab to the Customers page with the review list and moderation block
//      (scripts/ui/customer-reviews-admin.js), or refreshes its code; removes the standalone "Customer Reviews"
//      menu page created by earlier versions;
//   5. adds the Client Review Scores section to Statistics → Staff Performance (scripts/ui/staff-review-scores.js).
//      The first time, the block's original code is saved to scripts/backups/statistics-staff-block.original.js.
//      --remove-statistics takes the section out again.
//
// --check reports what would change and writes nothing. Same credentials and target rules as the other apply
// scripts (.env: NOCOBASE_API_TOKEN or INIT_ROOT_EMAIL/INIT_ROOT_PASSWORD; NOCOBASE_API_URL).

const fs = require('fs');
const path = require('path');
const { createClient, formatErrors } = require('./nocobase-api');
const {
  ADMIN_MARKER,
  CUSTOMERS_PAGE_TITLE,
  LEGACY_REVIEWS_PAGE_TITLE,
  PANEL_MARKER,
  PANEL_TITLE,
  PLUGIN_PACKAGE,
  REVIEWS_TAB_TITLE,
  REVIEW_NODE_TYPE,
  REVIEW_WORKFLOW_TITLE,
  SECTION_BEGIN,
  patchStatisticsCode,
  readUi,
  reviewWorkflowDefinition,
  reviewWorkflowNode,
  unpatchStatisticsCode,
} = require('./customer-reviews');

const BACKUP_PATH = path.join(__dirname, 'backups', 'statistics-staff-block.original.js');
const fail = (what, result) => new Error(`${what} failed (${result.status}):\n${formatErrors(result.json)}`);
const encode = (value) => encodeURIComponent(JSON.stringify(value));
const codeOf = (m) => String(m?.stepParams?.jsSettings?.runJs?.code || '');

async function listAllModels(client) {
  const all = [];
  for (let page = 1; page <= 20; page += 1) {
    const result = await client.request(`flowModels:list?pageSize=1000&page=${page}`);
    if (!result.ok) throw fail('flowModels:list', result);
    const rows = result.json?.data || [];
    all.push(...rows);
    if (rows.length < 1000) break;
  }
  return all;
}

async function setCode(client, model, code) {
  const stepParams = { ...model.stepParams, jsSettings: { ...(model.stepParams?.jsSettings || {}), runJs: { ...(model.stepParams?.jsSettings?.runJs || {}), version: 'v2', code } } };
  const result = await client.request(`flowModels:update?filterByTk=${model.uid}`, { method: 'POST', body: { stepParams } });
  if (!result.ok) throw fail(`flowModels:update ${model.uid}`, result);
}

async function addJsBlock(client, gridUid, title, code) {
  // Blocks must be added through flowSurfaces so the engine lays them out and links them to the grid.
  const result = await client.request('flowSurfaces:addBlock', { method: 'POST', body: { target: { uid: gridUid }, type: 'jsBlock', settings: { title, version: 'v2', code } } });
  if (!result.ok) throw fail(`flowSurfaces:addBlock on ${gridUid}`, result);
  return result.json?.data?.uid;
}

// 1 -----------------------------------------------------------------------------------------------------------
async function checkPlugin(client) {
  const result = await client.request('pm:list');
  if (!result.ok) throw fail('pm:list', result);
  const plugin = (result.json?.data || []).find((p) => p.packageName === PLUGIN_PACKAGE);
  if (!plugin || !plugin.enabled) throw new Error(`${PLUGIN_PACKAGE} is not enabled. Run: yarn install && yarn pm enable ${PLUGIN_PACKAGE}, restart, then re-run.`);
  const channels = await client.request(`notificationChannels:list?paginate=false&filter=${encode({ notificationType: 'email' })}`);
  const list = channels.ok ? channels.json?.data || [] : [];
  const wanted = process.env.REVIEW_EMAIL_CHANNEL;
  const channel = wanted ? list.find((c) => c.name === wanted || c.title === wanted) : list[0];
  return {
    plugin: `${plugin.packageName}@${plugin.version} enabled`,
    emailChannel: channel
      ? { name: channel.name, title: channel.title, host: channel.options?.host, from: channel.options?.from ? 'set' : 'not set (the SMTP account is used)' }
      : 'NONE: create an Email channel under Settings > Notification manager > Channels, or emails will fail (and can be retried later)',
  };
}

// 2 -----------------------------------------------------------------------------------------------------------
async function ensureWorkflow(client, { check, keepDisabled }) {
  const definition = reviewWorkflowDefinition();
  const list = await client.request(`workflows:list?paginate=false&filter=${encode({ title: REVIEW_WORKFLOW_TITLE })}&appends=versionStats`);
  if (!list.ok) throw fail('workflows:list', list);
  const versions = list.json?.data || [];
  let workflow = versions.find((w) => w.enabled) || versions.find((w) => w.current) || versions[0];
  let status = 'present';
  if (!workflow) {
    if (check) return { status: 'missing (would create and enable)' };
    const created = await client.request('workflows:create', { method: 'POST', body: { ...definition, enabled: false } });
    if (!created.ok) throw fail('workflows:create', created);
    workflow = created.json.data;
    status = 'created';
  }
  const nodes = await client.request(`workflows/${workflow.id}/nodes:list?paginate=false`);
  if (!nodes.ok) throw fail('nodes:list', nodes);
  const hasNode = (nodes.json?.data || []).some((n) => n.type === REVIEW_NODE_TYPE);
  const configDiffers = JSON.stringify(workflow.config || {}) !== JSON.stringify(definition.config);
  if (check) return { status: `${status}${hasNode ? '' : ' (node missing)'}${configDiffers ? ' (trigger differs)' : ''}${workflow.enabled ? '' : ' (disabled)'}`, id: workflow.id };

  if (!hasNode || configDiffers) {
    const executed = Number(workflow.versionStats?.executed || 0) > 0;
    if (executed) {
      // An executed version cannot be edited: NocoBase requires a new version (a copy), which is then edited.
      const revision = await client.request(`workflows:revision?filterByTk=${workflow.id}`, { method: 'POST', body: { key: workflow.key, title: REVIEW_WORKFLOW_TITLE } });
      if (!revision.ok) throw fail('workflows:revision', revision);
      workflow = revision.json.data;
      status = 'new version';
    }
    if (configDiffers) {
      const updated = await client.request(`workflows:update?filterByTk=${workflow.id}`, { method: 'POST', body: { config: definition.config, description: definition.description, sync: false } });
      if (!updated.ok) throw fail('workflows:update (config)', updated);
    }
    const current = await client.request(`workflows/${workflow.id}/nodes:list?paginate=false`);
    if (!(current.json?.data || []).some((n) => n.type === REVIEW_NODE_TYPE)) {
      const added = await client.request(`workflows/${workflow.id}/nodes:create`, { method: 'POST', body: { ...reviewWorkflowNode(), upstreamId: null } });
      if (!added.ok) throw fail('nodes:create', added);
    }
    if (status === 'present') status = 'updated';
  }
  if (!keepDisabled && !workflow.enabled) {
    const enabled = await client.request(`workflows:update?filterByTk=${workflow.id}`, { method: 'POST', body: { enabled: true } });
    if (!enabled.ok) throw fail('workflows:update (enable)', enabled);
    status += ', enabled';
  }
  return { status, id: workflow.id, enabled: !keepDisabled || !!workflow.enabled };
}

// 3 -----------------------------------------------------------------------------------------------------------
async function ensureAppointmentPanels(client, all, { check }) {
  const code = readUi('appointment-review-invitations.js');
  const byUid = new Map(all.map((m) => [m.uid, m]));
  const details = all.filter((m) => m.use === 'DetailsBlockModel' && m.stepParams?.resourceSettings?.init?.collectionName === 'appointments');
  const grids = Array.from(new Set(details.map((d) => d.parentId))).map((uid) => byUid.get(uid)).filter((g) => g && g.use === 'BlockGridModel');
  if (!grids.length) return { status: 'no appointment details drawer found' };
  const results = [];
  for (const grid of grids) {
    const existing = all.find((m) => m.parentId === grid.uid && m.use === 'JSBlockModel' && codeOf(m).includes(PANEL_MARKER));
    if (existing && codeOf(existing) === code) results.push({ grid: grid.uid, status: 'up to date' });
    else if (check) results.push({ grid: grid.uid, status: existing ? 'outdated (would refresh)' : 'missing (would add)' });
    else if (existing) {
      await setCode(client, existing, code);
      results.push({ grid: grid.uid, status: 'refreshed', block: existing.uid });
    } else {
      results.push({ grid: grid.uid, status: 'added', block: await addJsBlock(client, grid.uid, PANEL_TITLE, code) });
    }
  }
  return results;
}

// 4 -----------------------------------------------------------------------------------------------------------
function findInTree(node, predicate) {
  if (!node || typeof node !== 'object') return null;
  if (predicate(node)) return node;
  for (const value of Object.values(node.subModels || {})) {
    for (const child of Array.isArray(value) ? value : [value]) {
      const hit = findInTree(child, predicate);
      if (hit) return hit;
    }
  }
  return null;
}

async function ensureReviewsTab(client, { check }) {
  const code = readUi('customer-reviews-admin.js');
  const routes = await client.request(`desktopRoutes:list?paginate=false&appends[]=children&filter=${encode({ title: { $in: [CUSTOMERS_PAGE_TITLE, LEGACY_REVIEWS_PAGE_TITLE] }, type: 'flowPage' })}`);
  if (!routes.ok) throw fail('desktopRoutes:list', routes);
  const rows = routes.json?.data || [];
  const customers = rows.find((r) => r.title === CUSTOMERS_PAGE_TITLE);
  if (!customers) throw new Error(`The "${CUSTOMERS_PAGE_TITLE}" page was not found.`);
  const surface = await client.request(`flowSurfaces:get?pageSchemaUid=${customers.schemaUid}`);
  if (!surface.ok) throw fail('flowSurfaces:get (Customers)', surface);
  const pageModel = surface.json?.data?.tree;
  const tabRoute = (customers.children || []).find((c) => c.title === REVIEWS_TAB_TITLE);
  const result = { page: customers.schemaUid };
  let gridUid;
  let block = null;
  if (tabRoute) {
    const tabModel = findInTree(pageModel, (n) => n.uid === tabRoute.schemaUid);
    gridUid = findInTree(tabModel, (n) => n.use === 'BlockGridModel')?.uid;
    block = findInTree(tabModel, (n) => n.use === 'JSBlockModel' && codeOf(n).includes(ADMIN_MARKER));
    result.tab = { status: 'present', tabSchemaUid: tabRoute.schemaUid };
  } else if (check) {
    result.tab = { status: 'missing (would add)' };
  } else {
    // addTab takes the page model uid (RootPageModel), not the route's schemaUid.
    const added = await client.request('flowSurfaces:addTab', { method: 'POST', body: { target: { uid: pageModel.uid }, title: REVIEWS_TAB_TITLE, icon: 'StarOutlined' } });
    if (!added.ok) throw fail('flowSurfaces:addTab (Customer Reviews)', added);
    gridUid = added.json.data.gridUid;
    result.tab = { status: 'added', tabSchemaUid: added.json.data.tabSchemaUid };
  }
  if (block && codeOf(block) === code) result.block = 'up to date';
  else if (check) result.block = block ? 'outdated (would refresh)' : 'missing (would add)';
  else if (block) {
    await setCode(client, block, code);
    result.block = 'refreshed';
  } else {
    if (!gridUid) throw new Error('The Customer Reviews tab has no block grid.');
    await addJsBlock(client, gridUid, 'Customer reviews', code);
    result.block = 'added';
  }
  // Earlier versions used a standalone menu page; remove it once the tab exists (only if it is ours).
  const legacy = rows.find((r) => r.title === LEGACY_REVIEWS_PAGE_TITLE);
  if (legacy) {
    const legacySurface = await client.request(`flowSurfaces:get?pageSchemaUid=${legacy.schemaUid}`);
    const legacyTree = legacySurface.json?.data?.tree;
    const ours = JSON.stringify(legacyTree || {}).includes(ADMIN_MARKER);
    if (!ours) result.legacyPage = 'a "Customer Reviews" page exists that this script did not create; left alone';
    else if (check) result.legacyPage = 'present (would remove)';
    else {
      const destroyed = await client.request('flowSurfaces:destroyPage', { method: 'POST', body: { uid: legacyTree.uid } });
      if (!destroyed.ok) throw fail('flowSurfaces:destroyPage (legacy Customer Reviews page)', destroyed);
      result.legacyPage = 'removed';
    }
  }
  return result;
}

// 5 -----------------------------------------------------------------------------------------------------------
async function ensureStatisticsSection(client, all, { check, remove }) {
  const blocks = all.filter((m) => m.use === 'JSBlockModel' && /const BW_VIEW = 'staff';/.test(codeOf(m)));
  if (blocks.length !== 1) return { status: `expected one Staff Performance statistics block, found ${blocks.length}; not changed` };
  const block = blocks[0];
  const original = codeOf(block);
  const result = remove ? unpatchStatisticsCode(original) : patchStatisticsCode(original);
  if (!result.changed) return { status: remove ? 'not present' : 'up to date', block: block.uid };
  if (check) return { status: remove ? 'present (would remove)' : original.includes(SECTION_BEGIN) ? 'outdated (would refresh)' : 'missing (would add)', block: block.uid };
  if (!original.includes(SECTION_BEGIN) && !fs.existsSync(BACKUP_PATH)) {
    fs.mkdirSync(path.dirname(BACKUP_PATH), { recursive: true });
    fs.writeFileSync(BACKUP_PATH, original);
  }
  await setCode(client, block, result.code);
  return { status: remove ? 'removed' : original.includes(SECTION_BEGIN) ? 'refreshed' : 'added', block: block.uid, backup: fs.existsSync(BACKUP_PATH) ? path.relative(process.cwd(), BACKUP_PATH) : undefined };
}

async function main() {
  const check = process.argv.includes('--check');
  const keepDisabled = process.argv.includes('--keep-workflow-disabled');
  const remove = process.argv.includes('--remove-statistics');
  const client = await createClient();
  const summary = { status: 'ok', mode: check ? 'check' : 'apply', target: client.baseUrl };
  Object.assign(summary, await checkPlugin(client));
  summary.workflow = await ensureWorkflow(client, { check, keepDisabled });
  const all = await listAllModels(client);
  summary.appointmentPanels = await ensureAppointmentPanels(client, all, { check });
  summary.reviewsTab = await ensureReviewsTab(client, { check });
  summary.staffPerformance = await ensureStatisticsSection(client, all, { check, remove });
  console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Customer reviews apply failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { findInTree };
