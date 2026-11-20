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
//   4. creates the "Customer Reviews" page in the Beauty Within Portal menu with the review list and moderation
//      block (scripts/ui/customer-reviews-admin.js), or refreshes its code;
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
  MENU_GROUP_TITLE,
  PANEL_MARKER,
  PANEL_TITLE,
  PLUGIN_PACKAGE,
  REVIEWS_PAGE_TITLE,
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

async function ensureReviewsPage(client, { check }) {
  const code = readUi('customer-reviews-admin.js');
  const routes = await client.request(`desktopRoutes:list?paginate=false&filter=${encode({ title: { $in: [REVIEWS_PAGE_TITLE, MENU_GROUP_TITLE] } })}&fields=id,title,type,schemaUid,parentId`);
  if (!routes.ok) throw fail('desktopRoutes:list', routes);
  const rows = routes.json?.data || [];
  const group = rows.find((r) => r.title === MENU_GROUP_TITLE && r.type === 'group');
  const page = rows.find((r) => r.title === REVIEWS_PAGE_TITLE && r.type === 'flowPage');
  let pageSchemaUid = page?.schemaUid;
  let status = 'present';
  if (!pageSchemaUid) {
    if (check) return { status: 'missing (would create)' };
    const created = await client.request('flowSurfaces:createPage', { method: 'POST', body: { title: REVIEWS_PAGE_TITLE, icon: 'StarOutlined', parentMenuRouteId: group ? group.id : undefined, displayTitle: true } });
    if (!created.ok) throw fail('flowSurfaces:createPage', created);
    const data = created.json?.data || {};
    pageSchemaUid = data.pageSchemaUid || data.schemaUid || data.route?.schemaUid;
    if (!pageSchemaUid) throw new Error(`createPage returned no pageSchemaUid: ${JSON.stringify(data).slice(0, 300)}`);
    status = 'created';
  }
  const surface = await client.request(`flowSurfaces:get?pageSchemaUid=${pageSchemaUid}`);
  if (!surface.ok) throw fail('flowSurfaces:get', surface);
  const tree = surface.json?.data?.tree;
  const block = findInTree(tree, (n) => n.use === 'JSBlockModel' && codeOf(n).includes(ADMIN_MARKER));
  if (block && codeOf(block) === code) return { status, pageSchemaUid, url: `/admin/${pageSchemaUid}` };
  if (check) return { status: `${status} (${block ? 'block outdated' : 'block missing'})`, pageSchemaUid };
  if (block) {
    await setCode(client, block, code);
    return { status: `${status}, block refreshed`, pageSchemaUid, url: `/admin/${pageSchemaUid}` };
  }
  const grid = findInTree(tree, (n) => n.use === 'BlockGridModel');
  if (!grid) throw new Error('The Customer Reviews page has no block grid.');
  await addJsBlock(client, grid.uid, 'Customer reviews', code);
  return { status: `${status}, block added`, pageSchemaUid, url: `/admin/${pageSchemaUid}` };
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
  summary.reviewsPage = await ensureReviewsPage(client, { check });
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
