const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DELETE_CONFIRM,
  PAGE_SCHEMA_UID,
  REQUIRED_FORM_FIELDS,
  buildAppointmentsPageBlueprint,
  formFields,
  readToolbarScript,
} = require('./appointments-page-blueprint');
const { REQUIRED_FIELDS } = require('./appointments-schema');

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

test('toolbar script is embedded as a page asset and binds the table dynamically', () => {
  assert.equal(tab.blocks[0].type, 'jsBlock');
  assert.equal(tab.blocks[0].script, 'toolbar');
  assert.equal(blueprint.assets.scripts.toolbar.code, '// toolbar');
  const code = readToolbarScript();
  assert.ok(code.includes('"field":"category"'));
  assert.ok(code.includes('siblings.find(isAppointmentsTable)'));
});
