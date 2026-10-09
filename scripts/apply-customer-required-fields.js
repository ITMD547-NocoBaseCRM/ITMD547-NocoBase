// Marks the core customer fields as required on the Customers page create and edit forms.
//
// Usage: node scripts/apply-customer-required-fields.js
//
// Without this, the forms accept an empty submission and create a customer with no name or phone. A required
// form item shows the asterisk, blocks Submit, highlights the empty field and shows "<Field> is required".
// Safe to repeat: it only touches items that are not yet required.

const { createClient } = require('./nocobase-api');

const COLLECTION = 'customers';
const REQUIRED = ['firstName', 'lastName', 'phone', 'status'];

async function listAll(client) {
  const all = [];
  for (let page = 1; page <= 10; page += 1) {
    const result = await client.request(`flowModels:list?pageSize=1000&page=${page}`);
    const rows = (result.json && result.json.data) || [];
    all.push(...rows);
    if (rows.length < 1000) break;
  }
  return all;
}

// flowModels:list cannot filter by parent, so a form's items are read from its surface document.
async function formItems(client, formUid) {
  const result = await client.request(`flowSurfaces:get?uid=${formUid}`);
  if (!result.ok) throw new Error(`flowSurfaces:get ${formUid} failed (${result.status})`);
  const items = new Map();
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    const fieldPath = node.use === 'FormItemModel' && node.uid && node.stepParams?.fieldSettings?.init?.fieldPath;
    if (fieldPath) items.set(node.uid, { uid: node.uid, fieldPath, props: node.props || {} });
    for (const value of Object.values(node)) if (value && typeof value === 'object') walk(value);
  };
  walk(result.json.data || result.json);
  return [...items.values()];
}

async function main() {
  const client = await createClient();
  const all = await listAll(client);
  const forms = all.filter((m) => /^(Create|Edit)FormModel$/.test(m.use) && m.stepParams?.resourceSettings?.init?.collectionName === COLLECTION);
  if (!forms.length) throw new Error('No customer create/edit forms found');
  const changes = [];
  for (const form of forms) {
    const items = await formItems(client, form.uid);
    for (const item of items) {
      if (!REQUIRED.includes(item.fieldPath) || item.props.required === true) continue;
      const result = await client.request(`flowModels:update?filterByTk=${item.uid}`, { method: 'POST', body: { props: { ...item.props, required: true } } });
      if (!result.ok) throw new Error(`update ${item.fieldPath} on ${form.uid} failed (${result.status})`);
      changes.push(`${form.use} ${form.uid}: ${item.fieldPath}`);
    }
    const missing = REQUIRED.filter((name) => !items.some((item) => item.fieldPath === name));
    if (missing.length) console.warn(`${form.use} ${form.uid} has no item for: ${missing.join(', ')}`);
  }
  console.log(JSON.stringify({ status: 'ok', changed: changes.length > 0, forms: forms.map((f) => f.uid), changes }));
}

main().catch((error) => { console.error(error.message); process.exit(1); });
