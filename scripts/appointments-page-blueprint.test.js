const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DELETE_CONFIRM,
  PAGE_SCHEMA_UID,
  REQUIRED_FORM_FIELDS,
  buildAppointmentsPageBlueprint,
  formFields,
  formLayout,
  readToolbarScript,
  toolbarTabs,
} = require('./appointments-page-blueprint');
const { CATEGORY_TABS, REQUIRED_FIELDS } = require('./appointments-schema');

const blueprint = buildAppointmentsPageBlueprint({ toolbarCode: '// toolbar' });
const tab = blueprint.tabs[0];
const table = tab.blocks.find((block) => block.type === 'table');
const fieldName = (entry) => (typeof entry === 'string' ? entry : entry.field);

test('replaces the existing Appointments page instead of creating a duplicate', () => {
  assert.equal(blueprint.mode, 'replace');
  assert.equal(blueprint.target.pageSchemaUid, PAGE_SCHEMA_UID);
  assert.equal(blueprint.tabs.length, 1);
  assert.equal(table.collection, 'appointments');
});

test('table shows the T-40 domain fields and relations by readable paths', () => {
  const columns = table.fields.map(fieldName);
  for (const column of ['appointmentDate', 'startTime', 'endTime', 'category', 'status', 'notes']) {
    assert.ok(columns.includes(column), `missing ${column}`);
  }
  assert.ok(columns.includes('customer.firstName'));
  assert.ok(columns.includes('staff.firstName'));
  assert.ok(columns.includes('appointmentServices.service.name'));
  assert.ok(!columns.some((column) => /skin|sensitiv/i.test(column)), 'customer data must not be copied onto rows');
});

test('full CRUD is wired: create, view, edit, delete with confirmation', () => {
  const actionTypes = table.actions.map((action) => (typeof action === 'string' ? action : action.type));
  assert.deepEqual(actionTypes, ['filter', 'refresh', 'addNew', 'bulkDelete']);
  const addNew = table.actions.find((action) => action.type === 'addNew');
  assert.equal(addNew.popup.blocks[0].type, 'createForm');

  const recordTypes = table.recordActions.map((action) => action.type);
  assert.deepEqual(recordTypes, ['view', 'edit', 'delete']);
  const edit = table.recordActions.find((action) => action.type === 'edit');
  assert.equal(edit.popup.blocks[0].type, 'editForm');
  const remove = table.recordActions.find((action) => action.type === 'delete');
  assert.deepEqual(remove.settings.confirm, DELETE_CONFIRM);
  assert.equal(DELETE_CONFIRM.enable, true);
});

test('view popup shows details, booked services and an edit entry point', () => {
  const view = table.recordActions.find((action) => action.type === 'view');
  const types = view.popup.blocks.map((block) => block.type);
  assert.deepEqual(types, ['details', 'table']);
  const services = view.popup.blocks[1];
  assert.equal(services.resource.binding, 'associatedRecords');
  assert.equal(services.resource.associationField, 'appointmentServices');
  assert.equal(view.popup.blocks[0].recordActions[0].type, 'edit');
});

test('forms require exactly the NOT NULL columns and expose every supported field', () => {
  const fields = formFields();
  const required = fields.filter((entry) => typeof entry === 'object' && entry.settings?.required).map(fieldName);
  assert.deepEqual(required.sort(), [...REQUIRED_FORM_FIELDS].sort());
  // The schema module names customerId; the form binds the customer relation.
  const expectedFromSchema = REQUIRED_FIELDS.map((field) => (field === 'customerId' ? 'customer' : field)).sort();
  assert.deepEqual(required.sort(), expectedFromSchema);
  const names = fields.map(fieldName);
  for (const field of ['staff', 'endTime', 'notes', 'appointmentServices']) assert.ok(names.includes(field));
  assert.ok(!names.includes('externalId') && !names.includes('externalSource'), 'import identifiers are not editable');
  const services = fields.find((entry) => fieldName(entry) === 'appointmentServices');
  assert.equal(services.settings.fieldType, 'subTable');
  assert.ok(services.settings.fields.includes('service'));
});

test('form layout places every field once and gives the services sub-table the full width', () => {
  const layout = formLayout();
  const placed = layout.rows.flat().map((cell) => cell.key);
  assert.deepEqual(
    placed.sort(),
    formFields()
      .map((entry) => entry.key)
      .sort(),
  );
  assert.equal(new Set(placed).size, placed.length, 'a field is placed twice');
  for (const row of layout.rows) {
    assert.equal(
      row.reduce((sum, cell) => sum + cell.span, 0),
      24,
      'row spans must add up to 24',
    );
  }
  const servicesRow = layout.rows.find((row) => row.some((cell) => cell.key === 'appointmentServices'));
  assert.deepEqual(servicesRow, [{ key: 'appointmentServices', span: 24 }]);

  const addNew = table.actions.find((action) => action.type === 'addNew');
  assert.deepEqual(addNew.popup.blocks[0].fieldsLayout, layout);
  const edit = table.recordActions.find((action) => action.type === 'edit');
  assert.deepEqual(edit.popup.blocks[0].fieldsLayout, layout);
});

test('toolbar script is embedded as a page asset and binds the table dynamically', () => {
  assert.equal(tab.blocks[0].type, 'jsBlock');
  assert.equal(tab.blocks[0].script, 'toolbar');
  assert.equal(blueprint.assets.scripts.toolbar.code, '// toolbar');
  const code = readToolbarScript();
  assert.ok(code.includes('siblings.find(isAppointmentsTable)'));
});

test('toolbar tabs come from the T-40 schema module and carry the real category filters', () => {
  const tabs = toolbarTabs();
  assert.deepEqual(
    tabs.map(({ key, label, category }) => [key, label, category]),
    CATEGORY_TABS.map(({ key, label, category }) => [key, label, category]),
  );
  assert.deepEqual(
    tabs.map((entry) => entry.filter),
    [{}, { category: { $eq: 'session' } }, { category: { $eq: 'event' } }],
  );

  const code = readToolbarScript();
  assert.ok(!code.includes('/*APPOINTMENT_TABS*/'), 'the placeholder must be replaced');
  assert.ok(code.includes(`const TABS = ${JSON.stringify(tabs)};`), 'tabs are injected verbatim');
  assert.ok(code.includes('"$eq":"event"'), 'a "$" in the injected JSON must stay literal');
  // The old category dropdown is replaced by the tabs; a second control would contradict them.
  assert.ok(!code.includes('"field":"category","placeholder"'));
});

test('the toolbar only uses globals that the RunJS validator accepts', () => {
  const code = readToolbarScript();
  // flowSurfaces rejects unknown RunJS globals when the script is written; URLSearchParams is one of them
  assert.ok(!code.includes('URLSearchParams'));
  assert.ok(!code.includes('structuredClone'));
});

test('the toolbar never fetches appointment rows just to filter them', () => {
  const code = readToolbarScript();
  // counts are one-row requests; row data is requested only by the export action
  const listCalls = code.match(/CFG\.collection \+ ':list'[^)]*\)/g) || [];
  const rowFetches = listCalls.filter((call) => !call.includes('pageSize: 1'));
  assert.equal(rowFetches.length, 1, 'only the CSV export may request rows');
  assert.ok(rowFetches[0].includes('paginate: false') && rowFetches[0].includes('buildFilter(st)'));
});
