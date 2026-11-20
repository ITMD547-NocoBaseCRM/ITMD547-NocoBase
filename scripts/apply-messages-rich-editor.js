// Applies the rich-text email editing UI to the running NocoBase instance.
//
// Usage: yarn apply:messages-rich-editor [--check]
//
// Idempotent, in order:
//   1. On every page that edits `appointmentReminderSettings` (the Messages page's "Appointment
//      Reminder" tab and the Reminder Settings page), replaces the plain textarea form items for
//      `emailBody` / `confirmationBody` with a JS editable field running the same rich text editor
//      as the Customers page "Send message" dialog (scripts/ui/email-body-richtext-field.js).
//      The stored value stays the same raw HTML string, so the reminder SQL and the delivery
//      workflow are untouched.
//   2. Fills the Messages page's "Send Messages" tab with the send-message feature from the
//      Customers page (scripts/ui/messages-send-tab.js) as a JS block, or updates its code in
//      place when it already exists.
//
// --check reports what would change and writes nothing.

const fs = require('fs');
const path = require('path');
const { createClient, formatErrors } = require('./nocobase-api');

const SETTINGS_COLLECTION = 'appointmentReminderSettings';
const BODY_FIELDS = { emailBody: 'Email body (HTML)', confirmationBody: 'Confirmation email body (HTML)' };
const SEND_TAB_TITLE = 'Send Messages';
const MESSAGES_PAGE_TITLE = 'Messages';

const FIELD_CODE = fs.readFileSync(path.join(__dirname, 'ui', 'email-body-richtext-field.js'), 'utf8');
const SEND_TAB_CODE = fs.readFileSync(path.join(__dirname, 'ui', 'messages-send-tab.js'), 'utf8');

const fail = (what, result) => new Error(`${what} failed (${result.status}):\n${formatErrors(result.json)}`);

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

// The JS code stored on a runJs-backed model, wherever the step params put it.
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

// ─── 1. Email body fields → rich text (JS editable field) ────────────────────

async function applyBodyFields(client, check) {
  const routes = await client.request('desktopRoutes:list?paginate=false&fields=id,title,type,schemaUid');
  if (!routes.ok) throw fail('desktopRoutes:list', routes);
  const pages = (routes.json?.data || []).filter((r) => r.type === 'flowPage' && r.schemaUid);

  const out = [];
  for (const page of pages) {
    let root;
    try { root = await surface(client, page.schemaUid); } catch (e) { continue; }
    const forms = findAll(root, (n) => /FormModel$/.test(n.use) && n.stepParams?.resourceSettings?.init?.collectionName === SETTINGS_COLLECTION);
    for (const form of forms) {
      // A form that edits the subject but has no emailBody at all (e.g. a previous partial run
      // removed the textarea and the re-add failed): add the rich editor field back.
      const fieldPaths = new Set(findAll(form, (n) => !!n.stepParams?.fieldSettings?.init?.fieldPath).map((n) => n.stepParams.fieldSettings.init.fieldPath));
      if (fieldPaths.has('emailSubject') && !fieldPaths.has('emailBody')) {
        if (check) { out.push({ page: page.title, form: form.uid, fieldPath: 'emailBody', status: 'missing: would add rich editor' }); }
        else {
          const added = await client.request('flowSurfaces:addField', {
            method: 'POST',
            body: { target: { uid: form.uid }, fieldPath: 'emailBody', renderer: 'js', settings: { label: BODY_FIELDS.emailBody, code: FIELD_CODE, version: '1.0.0' } },
          });
          if (!added.ok) throw fail(`flowSurfaces:addField (${page.title} emailBody restore)`, added);
          out.push({ page: page.title, form: form.uid, fieldPath: 'emailBody', status: 'restored as rich editor' });
        }
      }
      const items = findAll(form, (n) => n.use === 'FormItemModel' && BODY_FIELDS[n.stepParams?.fieldSettings?.init?.fieldPath]);
      for (const item of items) {
        const fieldPath = item.stepParams.fieldSettings.init.fieldPath;
        const child = (item.subModels && Object.values(item.subModels).flat().find((n) => n && n.use)) || null;
        const entry = { page: page.title, form: form.uid, fieldPath, item: item.uid };

        if (child && child.use === 'JSEditableFieldModel') {
          if (getRunJsCode(child) === FIELD_CODE) {
            out.push({ ...entry, status: 'present' });
            continue;
          }
          if (check) { out.push({ ...entry, status: 'would update code' }); continue; }
          const result = await client.request('flowSurfaces:configure', {
            method: 'POST',
            body: { target: { uid: child.uid }, changes: { version: 'v2', code: FIELD_CODE } },
          });
          if (!result.ok) throw fail(`flowSurfaces:configure (${page.title} ${fieldPath})`, result);
          out.push({ ...entry, status: 'code updated' });
          continue;
        }

        if (check) { out.push({ ...entry, status: `would replace ${child ? child.use : 'field'} with rich editor` }); continue; }
        const label = item.stepParams?.editItemSettings?.label?.label || BODY_FIELDS[fieldPath];
        const removed = await client.request('flowSurfaces:removeNode', { method: 'POST', body: { target: { uid: item.uid } } });
        if (!removed.ok) throw fail(`flowSurfaces:removeNode (${page.title} ${fieldPath})`, removed);
        const added = await client.request('flowSurfaces:addField', {
          method: 'POST',
          body: { target: { uid: form.uid }, fieldPath, renderer: 'js', settings: { label, code: FIELD_CODE, version: '1.0.0' } },
        });
        if (!added.ok) throw fail(`flowSurfaces:addField (${page.title} ${fieldPath})`, added);
        out.push({ ...entry, status: 'replaced with rich editor' });
      }
    }
  }
  return out;
}

// ─── 2. Reminder intervals → multi-select dropdown ───────────────────────────
// The checkbox group takes a lot of space; a multi-select dropdown shows the chosen intervals
// compactly. Updates the collection field interface, then swaps the form items in place.

async function applyIntervalsDropdown(client, check) {
  const out = [];
  const field = await client.request(`collections/${SETTINGS_COLLECTION}/fields:get?filterByTk=enabledIntervals`);
  if (!field.ok) throw fail('fields:get enabledIntervals', field);
  const current = field.json?.data || {};
  const uiSchema = current.uiSchema || {};
  if (uiSchema['x-component'] !== 'Select') {
    if (check) out.push({ target: 'collection field', status: 'would switch to multipleSelect' });
    else {
      const updated = await client.request(`collections/${SETTINGS_COLLECTION}/fields:update?filterByTk=enabledIntervals`, {
        method: 'POST',
        body: {
          interface: 'multipleSelect',
          uiSchema: { ...uiSchema, 'x-component': 'Select', 'x-component-props': { mode: 'multiple' } },
        },
      });
      if (!updated.ok) throw fail('fields:update enabledIntervals', updated);
      out.push({ target: 'collection field', status: 'switched to multipleSelect' });
    }
  } else {
    out.push({ target: 'collection field', status: 'present' });
  }

  const routes = await client.request('desktopRoutes:list?paginate=false&fields=id,title,type,schemaUid');
  if (!routes.ok) throw fail('desktopRoutes:list', routes);
  for (const page of (routes.json?.data || []).filter((r) => r.type === 'flowPage' && r.schemaUid)) {
    let root;
    try { root = await surface(client, page.schemaUid); } catch (e) { continue; }
    const forms = findAll(root, (n) => /FormModel$/.test(n.use) && n.stepParams?.resourceSettings?.init?.collectionName === SETTINGS_COLLECTION);
    for (const form of forms) {
      const items = findAll(form, (n) => n.use === 'FormItemModel' && n.stepParams?.fieldSettings?.init?.fieldPath === 'enabledIntervals');
      for (const item of items) {
        const child = (item.subModels && Object.values(item.subModels).flat().find((n) => n && n.use)) || null;
        const entry = { page: page.title, form: form.uid, item: item.uid };
        if (child && child.use === 'SelectFieldModel') { out.push({ ...entry, status: 'present' }); continue; }
        if (check) { out.push({ ...entry, status: `would replace ${child ? child.use : 'field'} with dropdown` }); continue; }
        const label = item.stepParams?.editItemSettings?.label?.label || 'Reminder intervals';
        const removed = await client.request('flowSurfaces:removeNode', { method: 'POST', body: { target: { uid: item.uid } } });
        if (!removed.ok) throw fail(`flowSurfaces:removeNode (${page.title} enabledIntervals)`, removed);
        const added = await client.request('flowSurfaces:addField', {
          method: 'POST',
          body: { target: { uid: form.uid }, fieldPath: 'enabledIntervals', settings: { label } },
        });
        if (!added.ok) throw fail(`flowSurfaces:addField (${page.title} enabledIntervals)`, added);
        out.push({ ...entry, status: 'replaced with dropdown' });
      }
    }
  }
  return out;
}

// ─── 3. Send Messages tab ────────────────────────────────────────────────────

async function applySendTab(client, check) {
  const routes = await client.request('desktopRoutes:list?paginate=false&fields=id,title,type,schemaUid,parentId');
  if (!routes.ok) throw fail('desktopRoutes:list', routes);
  const rows = routes.json?.data || [];
  const page = rows.find((r) => r.type === 'flowPage' && r.title === MESSAGES_PAGE_TITLE);
  if (!page) return { status: `page "${MESSAGES_PAGE_TITLE}" not found: skipped` };
  const root = await surface(client, page.schemaUid);
  const tab = findAll(root, (n) => n.use === 'RootPageTabModel' && n.stepParams?.pageTabSettings?.tab?.title === SEND_TAB_TITLE)[0];
  if (!tab) return { status: `tab "${SEND_TAB_TITLE}" not found on ${MESSAGES_PAGE_TITLE}: skipped` };
  const grid = findAll(tab, (n) => n.use === 'BlockGridModel')[0];
  if (!grid) return { status: 'tab has no block grid: skipped' };

  const jsBlock = findAll(grid, (n) => n.use === 'JSBlockModel')[0];
  if (jsBlock) {
    if (getRunJsCode(jsBlock) === SEND_TAB_CODE) return { status: 'present', uid: jsBlock.uid };
    if (check) return { status: 'would update code', uid: jsBlock.uid };
    const result = await client.request('flowSurfaces:configure', {
      method: 'POST',
      body: { target: { uid: jsBlock.uid }, changes: { version: 'v2', code: SEND_TAB_CODE } },
    });
    if (!result.ok) throw fail('flowSurfaces:configure (Send Messages tab)', result);
    return { status: 'code updated', uid: jsBlock.uid };
  }

  if (check) return { status: 'would add JS block', grid: grid.uid };
  const added = await client.request('flowSurfaces:addBlock', {
    method: 'POST',
    body: { target: { uid: grid.uid }, type: 'jsBlock', settings: { code: SEND_TAB_CODE, version: '1.0.0' } },
  });
  if (!added.ok) throw fail('flowSurfaces:addBlock (Send Messages tab)', added);
  return { status: 'created', grid: grid.uid };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const check = process.argv.includes('--check');
  const client = await createClient();
  const summary = { status: 'ok', mode: check ? 'check' : 'apply', target: client.baseUrl };
  summary.bodyFields = await applyBodyFields(client, check);
  summary.intervalsDropdown = await applyIntervalsDropdown(client, check);
  summary.sendTab = await applySendTab(client, check);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(`Messages rich editor apply failed: ${error.message}`);
  process.exitCode = 1;
});
