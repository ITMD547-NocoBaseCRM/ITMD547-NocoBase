// Applies the customer activity filters to the running NocoBase instance.
//
// Usage: yarn apply:customer-activity [--page-schema-uid <uid>] [--toolbar-only] [--check]
//
// Requires `yarn migrate:customer-activity` first (the database view and the customer columns must exist). Then, in
// order and idempotently:
//   1. registers the read-only view collection `customerActivity` and the relation customers.activity if missing;
//   2. registers the cached activity columns on customers (lastVisitAt, visitsLast3m, ...) as fields if missing;
//   3. proves the server can filter and sort customers by them (a one-row list request); stops here on failure;
//   4. creates and enables the nightly "Refresh customer activity" workflow (schedule -> SQL node) if missing;
//   5. replaces the Customers page toolbar script in place (flowSurfaces:configure, seconds, uids unchanged);
//   6. adds the "Last visit" and "Total spent" columns to the Customers table if they are not there.
//
// --toolbar-only does step 5 only. --check reports what would change and writes nothing.
// Signs in with NOCOBASE_API_TOKEN or the INIT_ROOT_* credentials from .env; NOCOBASE_API_URL overrides the target
// (default http://localhost:$APP_PORT/api/).

const {
  PAGE_SCHEMA_UID,
  REFRESH_WORKFLOW_TITLE,
  RELATION_NAME,
  TABLE_COLUMNS,
  VIEW_NAME,
  activityRelationDefinition,
  customerActivityFields,
  readToolbarScript,
  refreshWorkflowDefinition,
  refreshWorkflowNodeDefinition,
  viewCollectionDefinition,
} = require('./customer-activity-page');
const { createClient, formatErrors, getSurface, loadEnv, resolveBaseUrl } = require('./nocobase-api');
const { findNode } = require('./appointments-page-layout');

function readArg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const fail = (what, result) => new Error(`${what} failed (${result.status}):\n${formatErrors(result.json)}`);
const encode = (value) => encodeURIComponent(JSON.stringify(value));

async function ensureViewCollection(client, check) {
  const existing = await client.request(`collections:get?filterByTk=${VIEW_NAME}`);
  if (existing.ok && existing.json?.data?.name === VIEW_NAME) return 'present';
  if (check) return 'missing';
  const created = await client.request('collections:create', { method: 'POST', body: viewCollectionDefinition() });
  if (!created.ok) throw fail(`collections:create ${VIEW_NAME}`, created);
  return 'created';
}

async function customerField(client, name) {
  const result = await client.request(`collections/customers/fields:get?filterByTk=${name}`);
  return result.ok && result.json?.data?.name === name ? result.json.data : null;
}

async function ensureRelation(client, check) {
  const existing = await customerField(client, RELATION_NAME);
  if (existing) {
    const target = existing.target || existing.options?.target;
    if (target && target !== VIEW_NAME) throw new Error(`customers.${RELATION_NAME} exists but targets ${target}, not ${VIEW_NAME}`);
    return 'present';
  }
  if (check) return 'missing';
  const created = await client.request('collections/customers/fields:create', { method: 'POST', body: activityRelationDefinition() });
  if (!created.ok) throw fail(`fields:create customers.${RELATION_NAME}`, created);
  return 'created';
}

async function ensureCustomerFields(client, check) {
  const out = { present: [], created: [] };
  for (const field of customerActivityFields()) {
    if (await customerField(client, field.name)) { out.present.push(field.name); continue; }
    if (check) { out.created.push(`${field.name} (dry run)`); continue; }
    const created = await client.request('collections/customers/fields:create', { method: 'POST', body: field });
    if (!created.ok) throw fail(`fields:create customers.${field.name}`, created);
    out.created.push(field.name);
  }
  return out;
}

// The whole feature depends on the server accepting these filters and sorts on the customers resource.
async function verifyServerSide(client) {
  const filter = encode({ visitsLast3m: { $gte: 0 } });
  const sort = encodeURIComponent('-lastVisitAt,firstName');
  const result = await client.request(`customers:list?pageSize=1&filter=${filter}&sort=${sort}&fields=id,firstName,visitCount,lastVisitAt,visitsLast3m,totalSpent`);
  if (!result.ok) throw fail('customers:list filtered and sorted by the activity columns', result);
  const row = (result.json?.data || [])[0];
  return { count: result.json?.meta?.count ?? 0, sample: row || null };
}

async function ensureRefreshWorkflow(client, check) {
  const list = await client.request(`workflows:list?paginate=false&filter=${encode({ title: REFRESH_WORKFLOW_TITLE })}`);
  if (!list.ok) throw fail('workflows:list', list);
  const existing = (list.json?.data || []).find((w) => w.current !== false) || (list.json?.data || [])[0];
  if (existing) return { status: existing.enabled ? 'present' : 'present (disabled: enable it in Workflow settings)', id: existing.id };
  if (check) return { status: 'missing' };
  const created = await client.request('workflows:create', { method: 'POST', body: { ...refreshWorkflowDefinition(), enabled: false } });
  if (!created.ok) throw fail('workflows:create', created);
  const id = created.json.data.id;
  const node = await client.request(`workflows/${id}/nodes:create`, { method: 'POST', body: refreshWorkflowNodeDefinition() });
  if (!node.ok) throw fail('workflows.nodes:create (SQL node)', node);
  const enabled = await client.request(`workflows:update?filterByTk=${id}`, { method: 'POST', body: { enabled: true } });
  if (!enabled.ok) throw fail('workflows:update (enable)', enabled);
  return { status: 'created', id };
}

function findCustomersPageTargets(page) {
  const isCustomersTable = (n) => n.use === 'TableBlockModel' && n.stepParams?.resourceSettings?.init?.collectionName === 'customers';
  const grid = findNode(page, (node) => {
    if (node.use !== 'BlockGridModel') return false;
    const items = node.subModels?.items || [];
    return items.some((n) => n.use === 'JSBlockModel') && items.some(isCustomersTable);
  });
  if (!grid) return null;
  const items = grid.subModels.items;
  return { toolbar: items.find((n) => n.use === 'JSBlockModel'), table: items.find(isCustomersTable) };
}

async function applyToolbar(client, toolbar, check) {
  const code = readToolbarScript();
  if (toolbar.stepParams?.jsSettings?.runJs?.code === code) return { changed: false, bytes: code.length };
  if (check) return { changed: true, bytes: code.length, dryRun: true };
  const result = await client.request('flowSurfaces:configure', {
    method: 'POST',
    body: { target: { uid: toolbar.uid }, changes: { version: 'v2', code } },
  });
  if (!result.ok) throw fail('flowSurfaces:configure (toolbar)', result);
  return { changed: true, bytes: code.length };
}

function tableFieldPaths(table) {
  const paths = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    const fieldPath = node.stepParams?.fieldSettings?.init?.fieldPath;
    if (fieldPath) paths.add(fieldPath);
    for (const value of Object.values(node.subModels || {})) (Array.isArray(value) ? value : [value]).forEach(walk);
  };
  walk(table);
  return paths;
}

// Columns are additive and optional: the toolbar works without them, so a refusal is reported, not fatal.
async function ensureColumns(client, table, check) {
  const present = tableFieldPaths(table);
  const out = { added: [], present: [], failed: [] };
  for (const column of TABLE_COLUMNS) {
    if (present.has(column.fieldPath)) { out.present.push(column.fieldPath); continue; }
    if (check) { out.added.push(`${column.fieldPath} (dry run)`); continue; }
    const result = await client.request('flowSurfaces:addField', {
      method: 'POST',
      body: { target: { uid: table.uid }, fieldPath: column.fieldPath, settings: { label: column.label } },
    });
    if (result.ok) out.added.push(column.fieldPath);
    else out.failed.push(`${column.fieldPath}: ${formatErrors(result.json)}`);
  }
  return out;
}

async function main() {
  const pageSchemaUid = readArg('--page-schema-uid', PAGE_SCHEMA_UID);
  const toolbarOnly = process.argv.includes('--toolbar-only');
  const check = process.argv.includes('--check');
  const client = await createClient();
  const summary = { status: 'ok', mode: check ? 'check' : 'apply', target: client.baseUrl, pageSchemaUid, url: `/admin/${pageSchemaUid}` };

  if (!toolbarOnly) {
    summary.viewCollection = await ensureViewCollection(client, check);
    summary.relation = await ensureRelation(client, check);
    summary.customerFields = await ensureCustomerFields(client, check);
    if (!check || summary.customerFields.created.length === 0) summary.serverSide = await verifyServerSide(client);
    summary.refreshWorkflow = await ensureRefreshWorkflow(client, check);
  }

  const page = await getSurface(client, { pageSchemaUid });
  const targets = findCustomersPageTargets(page);
  if (!targets || !targets.toolbar) throw new Error('The Customers page has no toolbar JS block next to the customers table; add a JS block above the table first');
  summary.toolbar = { uid: targets.toolbar.uid, ...(await applyToolbar(client, targets.toolbar, check)) };
  if (!toolbarOnly) summary.columns = { table: targets.table.uid, ...(await ensureColumns(client, targets.table, check)) };

  console.log(JSON.stringify(summary, null, 2));
  if (summary.columns?.failed?.length) process.exitCode = 2;
}

// A refused connection surfaces as an AggregateError with an empty message; name the target so the cause is obvious.
function describeError(error) {
  const causes = Array.isArray(error.errors) ? error.errors.map((e) => e.code || e.message).filter(Boolean) : [];
  const text = error.message || causes.join(', ') || String(error);
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET/.test(text + causes.join(','))) {
    return `${text} (could not reach ${resolveBaseUrl({ ...loadEnv(), ...process.env })}; is the app running there? Set NOCOBASE_API_URL to target another instance)`;
  }
  return text;
}

main().catch((error) => {
  console.error(`Customer activity apply failed: ${describeError(error)}`);
  process.exitCode = 1;
});
