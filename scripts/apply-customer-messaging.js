// Applies customer messaging (Send message button on the Customers page) to the running NocoBase instance.
//
// Usage: yarn apply:customer-messaging [--check] [--sms-webhook-url <url>] [--sms-auth-header "<value>"]
//
// Idempotent, in order:
//   1. creates the `customerMessages` collection (outbox and history) if missing;
//   2. creates and enables the workflow "Deliver customer messages" (collection event on new rows) if missing:
//      email -> notification channel "customer-email", SMS -> HTTP POST to the SMS gateway, then marks the row sent;
//   3. creates the "Customer messages" page under Salon Management if missing, with a table of the outbox;
//   4. refreshes the Customers page toolbar (yarn apply:customer-activity --toolbar-only does the same).
//
// The SMS gateway URL is taken from --sms-webhook-url, else NOCOBASE_SMS_WEBHOOK_URL in .env, else a placeholder
// that fails visibly. Change it later in the workflow's "Send SMS" node. --check reports and writes nothing.

const {
  DELIVERY_WORKFLOW_TITLE,
  MESSAGES_COLLECTION,
  MESSAGES_PAGE_TITLE,
  SMS_WEBHOOK_PLACEHOLDER,
  deliveryWorkflowDefinition,
  deliveryWorkflowNodes,
  messagesCollectionDefinition,
  messagesPageBlueprint,
} = require('./customer-messaging');
const { createClient, formatErrors, loadEnv } = require('./nocobase-api');

const MENU_GROUP_TITLE = 'Salon Management';
const PAGE_ICON = 'MessageOutlined';

function readArg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
const fail = (what, result) => new Error(`${what} failed (${result.status}):\n${formatErrors(result.json)}`);
const encode = (value) => encodeURIComponent(JSON.stringify(value));

async function ensureCollection(client, check) {
  const existing = await client.request(`collections:get?filterByTk=${MESSAGES_COLLECTION}`);
  if (existing.ok && existing.json?.data?.name === MESSAGES_COLLECTION) return 'present';
  if (check) return 'missing';
  const created = await client.request('collections:create', { method: 'POST', body: messagesCollectionDefinition() });
  if (!created.ok) throw fail(`collections:create ${MESSAGES_COLLECTION}`, created);
  return 'created';
}

// Any field of the definition the live collection lacks (for example the bookkeeping fields on an older install).
async function ensureFields(client, check) {
  const list = await client.request(`collections/${MESSAGES_COLLECTION}/fields:list?paginate=false`);
  if (!list.ok) throw fail('fields:list', list);
  const present = new Set((list.json?.data || []).map((f) => f.name));
  const out = { present: [], created: [] };
  for (const field of messagesCollectionDefinition().fields) {
    if (present.has(field.name)) { out.present.push(field.name); continue; }
    if (check) { out.created.push(`${field.name} (dry run)`); continue; }
    const created = await client.request(`collections/${MESSAGES_COLLECTION}/fields:create`, { method: 'POST', body: field });
    if (!created.ok) throw fail(`fields:create ${MESSAGES_COLLECTION}.${field.name}`, created);
    out.created.push(field.name);
  }
  return out;
}

// The email channel the workflow sends through. NocoBase gives a channel created in the UI an internal name such as
// "s_eze7ih9g9fo" (the title is only a label), so the name is resolved here: --email-channel / NOCOBASE_EMAIL_CHANNEL
// (name or title), else the only email-type channel, else the first one.
async function resolveEmailChannel(client, wanted) {
  const list = await client.request('notificationChannels:list?paginate=false');
  const channels = (list.ok && list.json?.data) || [];
  const emails = channels.filter((c) => c.notificationType === 'email');
  if (wanted) return channels.find((c) => c.name === wanted || c.title === wanted) || null;
  return emails[0] || null;
}

const nodeByTitle = (nodes, title) => nodes.find((n) => n.title === title);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function listNodes(client, workflowId) {
  const result = await client.request(`workflows/${workflowId}/nodes:list?paginate=false`);
  if (!result.ok) throw fail('nodes:list', result);
  return result.json?.data || [];
}

async function createNodes(client, workflowId, nodeOptions) {
  const ids = {};
  for (const node of deliveryWorkflowNodes(nodeOptions)) {
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

async function ensureWorkflow(client, check, nodeOptions) {
  const list = await client.request(`workflows:list?paginate=false&filter=${encode({ title: DELIVERY_WORKFLOW_TITLE })}&fields=id,key,title,enabled,current,createdAt&appends=versionStats`);
  if (!list.ok) throw fail('workflows:list', list);
  // Several versions can carry the title (a disabled previous version stays behind); the enabled one is the live one.
  const versions = (list.json?.data || []).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const existing = versions.find((w) => w.enabled) || versions.find((w) => w.current) || versions[0];
  const report = {
    smsProvider: nodeOptions.smsProvider,
    ...(nodeOptions.smsProvider === 'twilio' ? { twilioFrom: nodeOptions.twilio.from } : { smsWebhookUrl: nodeOptions.smsWebhookUrl }),
    emailChannelName: nodeOptions.emailChannelName,
  };

  if (!existing) {
    if (check) return { status: 'missing', ...report };
    const created = await client.request('workflows:create', { method: 'POST', body: { ...deliveryWorkflowDefinition(), enabled: false } });
    if (!created.ok) throw fail('workflows:create', created);
    const id = created.json.data.id;
    const nodes = await createNodes(client, id, nodeOptions);
    await setEnabled(client, id, true);
    return { status: 'created', id, nodes, ...report };
  }

  // Compare the delivery settings of the live nodes with what the definitions say; reconfigure if they differ.
  const live = await listNodes(client, existing.id);
  const wanted = deliveryWorkflowNodes(nodeOptions);
  const changes = wanted
    .filter((w) => ['Send email', 'Send SMS (HTTP POST to the gateway)'].includes(w.title))
    .map((w) => ({ title: w.title, config: w.config, live: nodeByTitle(live, w.title) }))
    .filter((c) => !c.live || !same(c.live.config, c.config));
  if (!changes.length) return { status: existing.enabled ? 'present' : 'present (disabled: enable it in Workflow settings)', id: existing.id, ...report };
  if (check) return { status: 'outdated (would reconfigure: ' + changes.map((c) => c.title).join(', ') + ')', id: existing.id, ...report };

  // An executed version cannot be edited: NocoBase requires a new version (a copy), which is then edited and enabled.
  let targetId = existing.id;
  let how = 'reconfigured in place';
  if ((existing.versionStats?.executed || 0) > 0) {
    // Same key = a new version of the same workflow (without the key NocoBase makes an independent copy named "... copy").
    const revision = await client.request(`workflows:revision?filterByTk=${existing.id}`, { method: 'POST', body: { key: existing.key, title: DELIVERY_WORKFLOW_TITLE } });
    if (!revision.ok) throw fail('workflows:revision', revision);
    targetId = revision.json.data.id;
    how = `new version ${targetId} (previous ${existing.id} disabled)`;
  }
  const targetNodes = targetId === existing.id ? live : await listNodes(client, targetId);
  for (const change of changes) {
    const node = nodeByTitle(targetNodes, change.title);
    if (!node) throw new Error(`Node "${change.title}" not found in workflow ${targetId}`);
    const updated = await client.request(`workflows/${targetId}/nodes:update?filterByTk=${node.id}`, { method: 'POST', body: { config: change.config } });
    if (!updated.ok) throw fail(`nodes:update ${change.title}`, updated);
  }
  if (targetId !== existing.id) {
    await setEnabled(client, existing.id, false);
    await setEnabled(client, targetId, true);
  } else if (!existing.enabled) await setEnabled(client, targetId, true);
  return { status: how, id: targetId, changed: changes.map((c) => c.title), ...report };
}

async function ensurePage(client, check) {
  const routes = await client.request(`desktopRoutes:list?paginate=false&filter=${encode({ title: { $in: [MESSAGES_PAGE_TITLE, MENU_GROUP_TITLE] } })}&fields=id,title,type,schemaUid,parentId`);
  if (!routes.ok) throw fail('desktopRoutes:list', routes);
  const rows = routes.json?.data || [];
  const group = rows.find((r) => r.title === MENU_GROUP_TITLE && r.type === 'group');
  const page = rows.find((r) => r.title === MESSAGES_PAGE_TITLE && r.type === 'flowPage' && (!group || r.parentId === group.id));
  let pageSchemaUid = page?.schemaUid;
  let status = 'present';
  if (!pageSchemaUid) {
    if (check) return { status: 'missing', menuGroup: group ? group.id : 'not found (page would be top-level)' };
    const created = await client.request('flowSurfaces:createPage', {
      method: 'POST',
      body: { title: MESSAGES_PAGE_TITLE, icon: PAGE_ICON, parentMenuRouteId: group ? group.id : undefined, displayTitle: true },
    });
    if (!created.ok) throw fail('flowSurfaces:createPage', created);
    const data = created.json?.data || {};
    pageSchemaUid = data.pageSchemaUid || data.schemaUid || data.route?.schemaUid;
    if (!pageSchemaUid) throw new Error(`createPage returned no pageSchemaUid: ${JSON.stringify(data).slice(0, 300)}`);
    status = 'created';
  }
  // The page may exist but be empty (for example when an earlier run failed after creating it): then fill it.
  const surface = await client.request(`flowSurfaces:get?pageSchemaUid=${pageSchemaUid}`);
  const hasTable = surface.ok && JSON.stringify(surface.json).includes(`"collectionName":"${MESSAGES_COLLECTION}"`);
  if (!hasTable) {
    if (check) return { status: `${status} (empty: blueprint would be applied)`, pageSchemaUid, url: `/admin/${pageSchemaUid}` };
    const applied = await client.request('flowSurfaces:applyBlueprint', { method: 'POST', body: messagesPageBlueprint({ pageSchemaUid }) });
    if (!applied.ok) throw fail('flowSurfaces:applyBlueprint (Customer messages)', applied);
    status = status === 'created' ? 'created' : 'filled';
  }
  return { status, pageSchemaUid, url: `/admin/${pageSchemaUid}` };
}

async function refreshToolbar(check) {
  const { spawnSync } = require('child_process');
  const args = [require.resolve('./apply-customer-activity'), '--toolbar-only', ...(check ? ['--check'] : [])];
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', env: process.env });
  if (result.status !== 0) throw new Error(`toolbar refresh failed:\n${result.stderr || result.stdout}`);
  try { return JSON.parse(result.stdout).toolbar; } catch { return { raw: result.stdout.trim() }; }
}

async function main() {
  const check = process.argv.includes('--check');
  const env = { ...loadEnv(), ...process.env };
  const client = await createClient();
  const emailChannel = await resolveEmailChannel(client, readArg('--email-channel', env.NOCOBASE_EMAIL_CHANNEL || ''));
  const twilio = {
    accountSid: readArg('--twilio-sid', env.TWILIO_ACCOUNT_SID || ''),
    authToken: readArg('--twilio-token', env.TWILIO_AUTH_TOKEN || ''),
    from: readArg('--twilio-from', env.TWILIO_FROM || ''),
  };
  const smsProvider = readArg('--sms-provider', env.NOCOBASE_SMS_PROVIDER || (twilio.accountSid && twilio.authToken && twilio.from ? 'twilio' : 'webhook'));
  const nodeOptions = {
    smsProvider,
    twilio,
    smsWebhookUrl: readArg('--sms-webhook-url', env.NOCOBASE_SMS_WEBHOOK_URL || SMS_WEBHOOK_PLACEHOLDER),
    smsAuthHeader: readArg('--sms-auth-header', env.NOCOBASE_SMS_AUTH_HEADER || ''),
    emailChannelName: emailChannel ? emailChannel.name : undefined,
  };
  const summary = { status: 'ok', mode: check ? 'check' : 'apply', target: client.baseUrl };
  summary.emailChannel = emailChannel ? { name: emailChannel.name, title: emailChannel.title, host: emailChannel.options?.host } : 'none configured (create an Email channel under Settings → Notification management, then re-run)';
  summary.collection = await ensureCollection(client, check);
  if (summary.collection !== 'missing') summary.fields = await ensureFields(client, check);
  summary.workflow = await ensureWorkflow(client, check, nodeOptions);
  summary.page = await ensurePage(client, check);
  summary.toolbar = await refreshToolbar(check);
  const notes = [];
  if (smsProvider === 'webhook' && nodeOptions.smsWebhookUrl === SMS_WEBHOOK_PLACEHOLDER) notes.push('SMS not configured: set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM in .env (or NOCOBASE_SMS_WEBHOOK_URL for another gateway) and re-run.');
  if (!emailChannel) notes.push('No email channel: emails will fail with "channel not found" until one exists and the apply is re-run.');
  else if (/^https?:\/\//.test(emailChannel.options?.host || '')) notes.push(`Email channel "${emailChannel.title}" has host ${emailChannel.options.host}: that is a web address, not an SMTP server (Gmail: smtp.gmail.com, port 465, secure on, an App Password, and a From like "Salon <you@gmail.com>").`);
  if (notes.length) summary.notes = notes;
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(`Customer messaging apply failed: ${error.message}`);
  process.exitCode = 1;
});
