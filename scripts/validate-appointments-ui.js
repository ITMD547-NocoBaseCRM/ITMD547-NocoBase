// Reads the live Appointments page back through flow-surfaces and asserts the T-42 CRUD structure.
//
// Usage: yarn validate:appointments-ui [--page-schema-uid <uid>]

const {
  PAGE_SCHEMA_UID,
  REQUIRED_FORM_FIELDS,
  readToolbarScript,
  toolbarTabs,
} = require('./appointments-page-blueprint');
const {
  findDetailsLayoutTarget,
  findNode,
  findPageLayoutTarget,
  isFullWidthRow,
  isStacked,
} = require('./appointments-page-layout');
const { createClient, getSurface } = require('./nocobase-api');

function readArg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function walk(node, visit, depth = 0) {
  if (!node || typeof node !== 'object') return;
  visit(node, depth);
  for (const value of Object.values(node.subModels || {})) {
    for (const child of Array.isArray(value) ? value : [value]) walk(child, visit, depth + 1);
  }
}

function collect(tree) {
  const nodes = [];
  walk(tree, (node) => nodes.push(node));
  return nodes;
}

const fieldPathOf = (node) => node.stepParams?.fieldSettings?.init?.fieldPath;
const collectionOf = (node) =>
  node.stepParams?.resourceSettings?.init?.collectionName || node.stepParams?.resourceSettings?.init?.associationName;
const titleOf = (node) => String(node.stepParams?.buttonSettings?.general?.title ?? node.props?.title ?? '');

const readSurface = getSurface;

// Asserts that the grid holding `order` (found by `locate`) shows one full-width block per row.
function expectStacked(tree, locate, label) {
  const target = locate(tree);
  expect(target, `${label}: the blocks to stack were not found`);
  const grid = findNode(tree, (node) => node.uid === target.gridUid);
  expect(isStacked(grid, target.order), `${label}: blocks are not stacked one per row at full width`);
}

async function main() {
  const pageSchemaUid = readArg('--page-schema-uid', PAGE_SCHEMA_UID);
  const client = await createClient();
  const page = await readSurface(client, { pageSchemaUid });
  expectStacked(page, findPageLayoutTarget, 'page');
  const nodes = collect(page);

  const table = nodes.find((node) => node.use === 'TableBlockModel' && collectionOf(node) === 'appointments');
  expect(table, 'appointments TableBlockModel is missing from the page');
  // Only the main table's own columns and actions; nested popups contain their own tables.
  const columns = table.subModels?.columns || [];
  const tableNodes = [...columns, ...(table.subModels?.actions || [])];

  const columnPaths = columns.filter((node) => node.use === 'TableColumnModel').map(fieldPathOf);
  for (const column of [
    'appointmentDate',
    'startTime',
    'category',
    'status',
    'customer.firstName',
    'staff.firstName',
  ]) {
    expect(columnPaths.includes(column), `table column ${column} is missing`);
  }

  const toolbar = nodes.find((node) => node.use === 'JSBlockModel');
  expect(toolbar, 'toolbar JSBlockModel is missing');
  const toolbarCode = String(toolbar.stepParams?.jsSettings?.runJs?.code || '');
  // The live toolbar must be exactly what the repo builds: type tabs, URL sync and refresh handling included.
  expect(
    toolbarCode === readToolbarScript(),
    'toolbar script differs from the repo version; run yarn apply:appointments-toolbar',
  );
  for (const tab of toolbarTabs()) {
    expect(toolbarCode.includes(JSON.stringify(tab)), `toolbar is missing the ${tab.label} tab`);
  }
  expect(
    toolbarCode.includes('siblings.find(isAppointmentsTable)'),
    'toolbar still binds the table by hard-coded uid only',
  );

  const actionUses = tableNodes.map((node) => node.use);
  for (const use of ['AddNewActionModel', 'FilterActionModel', 'RefreshActionModel', 'BulkDeleteActionModel']) {
    expect(actionUses.includes(use), `table action ${use} is missing`);
  }
  const actionsColumn = tableNodes.find((node) => node.use === 'TableActionsColumnModel');
  expect(actionsColumn, 'TableActionsColumnModel is missing');
  // Direct row actions only; nested popups (for example the booked-services table) have their own.
  const rowActions = actionsColumn.subModels?.actions || [];
  const view = rowActions.find((node) => node.use === 'ViewActionModel');
  const edit = rowActions.find((node) => node.use === 'EditActionModel');
  const remove = rowActions.find((node) => node.use === 'DeleteActionModel');
  expect(view && edit && remove, 'row actions View / Edit / Delete are not all present');
  expect(remove.stepParams?.deleteSettings?.confirm?.enable === true, 'Delete action does not require confirmation');
  expect(
    String(remove.stepParams?.deleteSettings?.confirm?.title || '').includes('Delete appointment'),
    'Delete confirmation does not name the appointment',
  );

  // Popups are stored as their own surfaces; read each opener's popup by uid.
  const addNew = tableNodes.find((node) => node.use === 'AddNewActionModel');
  const openers = [
    ['create', addNew, 'CreateFormModel'],
    ['edit', edit, 'EditFormModel'],
    ['view', view, 'DetailsBlockModel'],
  ];
  const forms = {};
  for (const [name, opener, expectedUse] of openers) {
    expect(opener?.uid, `${name} opener action is missing`);
    // The page-level readback does not expand popup pages; read the opener by its own uid.
    const popup = await readSurface(client, { uid: opener.uid });
    const popupNodes = collect(popup);
    const block = popupNodes.find((node) => node.use === expectedUse);
    expect(block, `${name} popup does not contain a ${expectedUse}`);
    forms[name] = { popupNodes, block };
  }

  for (const name of ['create', 'edit']) {
    const items = forms[name].popupNodes.filter((node) => node.use === 'FormItemModel');
    const paths = items.map(fieldPathOf);
    for (const field of [...REQUIRED_FORM_FIELDS, 'staff', 'endTime', 'notes', 'appointmentServices']) {
      expect(paths.includes(field), `${name} form is missing field ${field}`);
    }
    for (const field of REQUIRED_FORM_FIELDS) {
      const item = items.find((node) => fieldPathOf(node) === field);
      const required = item.props?.required === true || item.stepParams?.fieldSettings?.required === true;
      expect(required, `${name} form field ${field} is not marked required`);
    }
    expect(
      forms[name].popupNodes.some((node) => node.use === 'FormSubmitActionModel'),
      `${name} form has no submit action`,
    );
    // The booked-services sub-table is clipped in a half-width cell; it must own a full-width row.
    const formGrid = forms[name].popupNodes.find((node) => node.use === 'FormGridModel');
    const servicesItem = items.find((node) => fieldPathOf(node) === 'appointmentServices');
    expect(
      formGrid && isFullWidthRow(formGrid, servicesItem.uid),
      `${name} form: booked services do not have a full-width row`,
    );
  }

  expectStacked(forms.view.popupNodes[0], findDetailsLayoutTarget, 'view popup');
  const viewNodes = forms.view.popupNodes;
  expect(
    viewNodes.some((node) => node.use === 'TableBlockModel' && collectionOf(node) === 'appointmentServices'),
    'view popup is missing the booked services table',
  );
  expect(
    viewNodes.some((node) => node.use === 'EditActionModel'),
    'view popup has no Edit action',
  );
  expect(
    viewNodes.some((node) => node.use === 'DetailsItemModel' && fieldPathOf(node) === 'category'),
    'view popup details do not show category',
  );

  console.log(
    JSON.stringify(
      {
        status: 'ok',
        pageSchemaUid,
        table: table.uid,
        columns: columnPaths.length,
        rowActions: [titleOf(view), titleOf(edit), titleOf(remove)].map((title) =>
          title.replace(/\{\{t\("(.*)"\)\}\}/, '$1'),
        ),
        deleteConfirm: true,
        forms: Object.fromEntries(
          Object.entries(forms).map(([name, { popupNodes }]) => [
            name,
            popupNodes.filter((node) => node.use === 'FormItemModel' || node.use === 'DetailsItemModel').length,
          ]),
        ),
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(`Appointments UI validation failed: ${error.message}`);
  process.exitCode = 1;
});
