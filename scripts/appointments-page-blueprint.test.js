const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DELETE_CONFIRM,
  PAGE_SCHEMA_UID,
  REQUIRED_FORM_FIELDS,
  buildAppointmentsPageBlueprint,
  formFields,
  formLayout,
  REMOVED_FORM_FIELDS,
  readSensitivityScript,
  readToolbarScript,
  toolbarTabs,
} = require('./appointments-page-blueprint');
const { CATEGORY_TABS, DERIVED_FIELDS, REQUIRED_FIELDS } = require('./appointments-schema');

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
  // customer data is only ever read through the customer relation, never a field of the appointment itself
  for (const column of columns.filter((name) => /skin|sensitiv/i.test(name))) {
    assert.match(column, /^customer./, 'sensitivity data must come through Appointment -> Customer');
  }
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

test('customer sensitivities are read through the customer relation by JS renderers, in the table and in details', () => {
  const cell = table.fields.find((entry) => entry.script === 'sensitivityCell');
  assert.deepEqual(cell, {
    key: 'sensitivityCell',
    field: 'customer.skinSensitivities',
    renderer: 'js',
    script: 'sensitivityCell',
    settings: { label: 'Sensitivities' },
  });
  const names = table.fields.map(fieldName);
  assert.equal(
    names.indexOf('customer.skinSensitivities'),
    names.indexOf('customer.firstName') + 1,
    'next to the customer',
  );

  const view = table.recordActions.find((action) => action.type === 'view');
  const details = view.popup.blocks.find((block) => block.type === 'details');
  const inDetails = details.fields.find((entry) => entry.script === 'sensitivityDetails');
  assert.equal(inDetails.field, 'customer.skinSensitivities');
  assert.equal(inDetails.renderer, 'js');

  // never an appointment field of its own, and not part of the create/edit forms
  const everyField = JSON.stringify([table.fields, details.fields]);
  assert.ok(!/"field":"skinSensitivities/.test(everyField), 'no sensitivity field directly on the appointment');
  assert.ok(!JSON.stringify(formFields()).match(/skin|sensitiv/i), 'forms do not carry customer sensitivities');
});

test('each sensitivity rendering is its own asset with the right variant', () => {
  const built = buildAppointmentsPageBlueprint();
  const { sensitivityCell, sensitivityDetails } = built.assets.scripts;
  assert.equal(sensitivityCell.version, 'v2');
  assert.match(sensitivityCell.code, /const VARIANT = 'cell';/);
  assert.match(sensitivityDetails.code, /const VARIANT = 'details';/);
  assert.equal(sensitivityCell.code, readSensitivityScript('cell'));
  assert.equal(sensitivityDetails.code, readSensitivityScript('details'));
  assert.ok(!sensitivityCell.code.includes('/*SENSITIVITY_VARIANT*/'));
  assert.throws(() => readSensitivityScript('wide'), /Unknown sensitivity variant/);
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

test('forms do not ask for the derived appointment date, but the table and details still show it', () => {
  assert.deepEqual(REMOVED_FORM_FIELDS, DERIVED_FIELDS);
  const names = formFields().map(fieldName);
  for (const derived of DERIVED_FIELDS) assert.ok(!names.includes(derived), `${derived} must not be a form field`);
  const layoutKeys = formLayout()
    .rows.flat()
    .map((cell) => cell.key);
  for (const derived of DERIVED_FIELDS) assert.ok(!layoutKeys.includes(derived));
  // the start and end times now share a row
  const timeRow = formLayout().rows.find((row) => row.some((cell) => cell.key === 'startTime'));
  assert.deepEqual(timeRow, [
    { key: 'startTime', span: 12 },
    { key: 'endTime', span: 12 },
  ]);
  const columns = table.fields.map(fieldName);
  assert.ok(columns.includes('appointmentDate'), 'the date is still a table column');
  const view = table.recordActions.find((action) => action.type === 'view');
  assert.ok(
    view.popup.blocks
      .find((block) => block.type === 'details')
      .fields.map(fieldName)
      .includes('appointmentDate'),
  );
});
