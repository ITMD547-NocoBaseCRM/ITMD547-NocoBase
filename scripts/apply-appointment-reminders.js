// Applies the automated appointment email reminder system to the running NocoBase instance.
//
// Usage: yarn apply:appointment-reminders [--check]
//
// Idempotent, in order:
//   1. creates the `appointmentReminderSettings` collection (singleton: intervals, template, master switch) if missing;
//   2. creates the `appointmentReminders` collection (one row per appointment × interval) if missing;
//   3. seeds the default settings row if the settings collection is empty;
//   4. creates and enables the scheduled workflow "Process appointment reminders" (every 15 min, two SQL nodes) if missing;
//   5. creates the "Reminder settings" page under the portal menu group if missing, with a settings form + log table.
//
// Reminder rows are created by the server-side hook in plugin.ts (appointments.afterSave), not a workflow.
// The scheduled workflow only picks up due reminders and queues customerMessages rows for delivery.
//
// Requires: the `customerMessages` collection and "Deliver customer messages" workflow (yarn apply:customer-messaging).
// --check reports what would change and writes nothing.

const {
  DEFAULT_EMAIL_BODY,
  DEFAULT_EMAIL_SUBJECT,
  PROCESS_WORKFLOW_TITLE,
  REMINDERS_COLLECTION,
  SETTINGS_COLLECTION,
  SETTINGS_PAGE_TITLE,
  processWorkflowDefinition,
  processWorkflowNodes,
  remindersCollectionDefinition,
  settingsCollectionDefinition,
  settingsPageBlueprint,
} = require('./appointment-reminders');
const { createClient, formatErrors, loadEnv } = require('./nocobase-api');

const MENU_GROUP_TITLE = 'Beauty Within Portal';
const PAGE_ICON = 'BellOutlined';

const fail = (what, result) => new Error(`${what} failed (${result.status}):\n${formatErrors(result.json)}`);
const encode = (value) => encodeURIComponent(JSON.stringify(value));

// ─── Collection helpers ──────────────────────────────────────────────────────

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

// ─── Seed default settings ───────────────────────────────────────────────────

async function ensureDefaultSettings(client, check) {
  const list = await client.request(`${SETTINGS_COLLECTION}:list?pageSize=1`);
  if (list.ok && list.json?.data?.length > 0) return 'present';
  if (check) return 'missing (would seed default row)';
  const created = await client.request(`${SETTINGS_COLLECTION}:create`, {
    method: 'POST',
    body: {
      enabled: true,
      enabledIntervals: ['24h', '48h'],
      emailSubject: DEFAULT_EMAIL_SUBJECT,
      emailBody: DEFAULT_EMAIL_BODY,
    },
  });
  if (!created.ok) throw fail(`${SETTINGS_COLLECTION}:create (default row)`, created);
  return 'seeded';
}

// ─── Workflow helpers ────────────────────────────────────────────────────────

async function listNodes(client, workflowId) {
  const result = await client.request(`workflows/${workflowId}/nodes:list?paginate=false`);
  if (!result.ok) throw fail('nodes:list', result);
  return result.json?.data || [];
}

async function createNodes(client, workflowId, nodes) {
  const ids = {};
  for (const node of nodes) {
    const { key, upstream, branch, ...values } = node;
    const body = { ...values, upstreamId: upstream ? ids[upstream] : null, branchIndex: branch ?? null };
    const result = await client.request(`workflows/${workflowId}/nodes:create`, { method: 'POST', body });
    if (!result.ok) throw fail(`nodes:create ${key}`, result);
    ids[key] = result.json.data.id;
  }
  return ids;
}

async function setEnabled(client, workflowId, enabled) {
  const result = await client.request(`workflows:update?filterByTk=${workflowId}`, { method: 'POST', body: { enabled } });
  if (!result.ok) throw fail(`workflows:update (enabled=${enabled})`, result);
}

async function ensureWorkflow(client, check, title, definition, nodes) {
  const list = await client.request(`workflows:list?paginate=false&filter=${encode({ title })}&fields=id,key,title,enabled,current,createdAt&appends=versionStats`);
  if (!list.ok) throw fail('workflows:list', list);
  const versions = (list.json?.data || []).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const existing = versions.find((w) => w.enabled) || versions.find((w) => w.current) || versions[0];

  if (!existing) {
    if (check) return { status: 'missing' };
    const created = await client.request('workflows:create', { method: 'POST', body: { ...definition, enabled: false } });
    if (!created.ok) throw fail('workflows:create', created);
    const id = created.json.data.id;
    await createNodes(client, id, nodes);
    await setEnabled(client, id, true);
    return { status: 'created', id };
  }

  // If it exists but has no nodes (or too few), it's an incomplete previous attempt: add nodes.
  const existingNodes = await listNodes(client, existing.id);
  if (existingNodes.length < nodes.length) {
    if (check) return { status: 'incomplete (would add missing nodes)', id: existing.id };
    // An executed version cannot be edited: need a revision.
    let targetId = existing.id;
    if ((existing.versionStats?.executed || 0) > 0) {
      const revision = await client.request(`workflows:revision?filterByTk=${existing.id}`, { method: 'POST', body: { key: existing.key, title } });
      if (!revision.ok) throw fail('workflows:revision', revision);
      targetId = revision.json.data.id;
    }
    if (targetId !== existing.id) {
      await createNodes(client, targetId, nodes);
      await setEnabled(client, existing.id, false);
      await setEnabled(client, targetId, true);
      return { status: `completed (new version ${targetId})`, id: targetId };
    }
    // Not executed yet: add nodes in place.
    await createNodes(client, targetId, nodes);
    if (!existing.enabled) await setEnabled(client, targetId, true);
    return { status: 'completed', id: targetId };
  }

  return { status: existing.enabled ? 'present' : 'present (disabled: enable it in Workflow settings)', id: existing.id };
}

// ─── Page ────────────────────────────────────────────────────────────────────

async function ensurePage(client, check) {
  const routes = await client.request(`desktopRoutes:list?paginate=false&filter=${encode({ title: { $in: [SETTINGS_PAGE_TITLE, MENU_GROUP_TITLE] } })}&fields=id,title,type,schemaUid,parentId`);
  if (!routes.ok) throw fail('desktopRoutes:list', routes);
  const rows = routes.json?.data || [];
  const group = rows.find((r) => r.title === MENU_GROUP_TITLE && r.type === 'group');
  const page = rows.find((r) => r.title === SETTINGS_PAGE_TITLE && r.type === 'flowPage' && (!group || r.parentId === group.id));
  let pageSchemaUid = page?.schemaUid;
  let status = 'present';

  if (!pageSchemaUid) {
    if (check) return { status: 'missing', menuGroup: group ? group.id : 'not found (page would be top-level)' };
    const created = await client.request('flowSurfaces:createPage', {
      method: 'POST',
      body: { title: SETTINGS_PAGE_TITLE, icon: PAGE_ICON, parentMenuRouteId: group ? group.id : undefined, displayTitle: true },
    });
    if (!created.ok) throw fail('flowSurfaces:createPage', created);
    const data = created.json?.data || {};
    pageSchemaUid = data.pageSchemaUid || data.schemaUid || data.route?.schemaUid;
    if (!pageSchemaUid) throw new Error(`createPage returned no pageSchemaUid: ${JSON.stringify(data).slice(0, 300)}`);
    status = 'created';
  }

  // Fill the page if it's empty.
  const surface = await client.request(`flowSurfaces:get?pageSchemaUid=${pageSchemaUid}`);
  const hasForm = surface.ok && JSON.stringify(surface.json).includes(`"collectionName":"${SETTINGS_COLLECTION}"`);
  if (!hasForm) {
    if (check) return { status: `${status} (empty: blueprint would be applied)`, pageSchemaUid, url: `/admin/${pageSchemaUid}` };
    const applied = await client.request('flowSurfaces:applyBlueprint', { method: 'POST', body: settingsPageBlueprint({ pageSchemaUid }) });
    if (!applied.ok) throw fail('flowSurfaces:applyBlueprint (Reminder settings)', applied);
    status = status === 'created' ? 'created' : 'filled';
  }

  return { status, pageSchemaUid, url: `/admin/${pageSchemaUid}` };
}

// ─── Dependency check ────────────────────────────────────────────────────────

async function checkDependencies(client) {
  const notes = [];
  const msgColl = await client.request('collections:get?filterByTk=customerMessages');
  if (!msgColl.ok || msgColl.json?.data?.name !== 'customerMessages') {
    notes.push('⚠ customerMessages collection not found. Run "yarn apply:customer-messaging" first.');
  }
  const wfList = await client.request(`workflows:list?paginate=false&filter=${encode({ title: 'Deliver customer messages' })}&fields=id,enabled`);
  const deliveryWf = (wfList.json?.data || []).find((w) => w.enabled);
  if (!deliveryWf) {
    notes.push('⚠ "Deliver customer messages" workflow not found or disabled. Run "yarn apply:customer-messaging" first.');
  }
  const chList = await client.request('notificationChannels:list?paginate=false');
  const emailCh = (chList.ok && chList.json?.data || []).find((c) => c.notificationType === 'email');
  if (!emailCh) {
    notes.push('⚠ No email notification channel configured. Create one under Settings → Notification management.');
  }
  return notes;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const check = process.argv.includes('--check');
  const client = await createClient();
  const summary = { status: 'ok', mode: check ? 'check' : 'apply', target: client.baseUrl };

  summary.dependencies = await checkDependencies(client);

  // Collections
  const settingsDef = settingsCollectionDefinition();
  const remindersDef = remindersCollectionDefinition();
  summary.settingsCollection = await ensureCollection(client, check, SETTINGS_COLLECTION, settingsDef);
  if (summary.settingsCollection !== 'missing') {
    summary.settingsFields = await ensureFields(client, check, SETTINGS_COLLECTION, settingsDef);
  }
  summary.remindersCollection = await ensureCollection(client, check, REMINDERS_COLLECTION, remindersDef);
  if (summary.remindersCollection !== 'missing') {
    summary.remindersFields = await ensureFields(client, check, REMINDERS_COLLECTION, remindersDef);
  }

  // Default settings row
  if (summary.settingsCollection !== 'missing') {
    summary.defaultSettings = await ensureDefaultSettings(client, check);
  }

  // Workflow
  summary.processWorkflow = await ensureWorkflow(
    client, check, PROCESS_WORKFLOW_TITLE,
    processWorkflowDefinition(),
    processWorkflowNodes(),
  );

  // Page
  summary.page = await ensurePage(client, check);

  if (summary.dependencies.length) summary.notes = summary.dependencies;
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(`Appointment reminders apply failed: ${error.message}`);
  process.exitCode = 1;
});
