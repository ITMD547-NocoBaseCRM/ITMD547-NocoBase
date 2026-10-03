// Layout helpers for the Appointments page (US-26).
//
// The page blueprint cannot express "toolbar above table" and "details above booked services":
// the authoring validator rejects a layout where every block sits on its own row and the public
// grammar has no stacked cells. The blocks are therefore authored side by side and arranged
// afterwards through the low-level `flowSurfaces:setLayout` action, using these pure helpers.

const FULL_WIDTH = 24;

// Low-level layout payload: one block per row, each spanning the full width.
function stackedLayout(uids) {
  const keys = uids.map((_, index) => `row${index + 1}`);
  return {
    rows: Object.fromEntries(uids.map((uid, index) => [keys[index], [[uid]]])),
    sizes: Object.fromEntries(keys.map((key) => [key, [FULL_WIDTH]])),
    rowOrder: keys,
  };
}

function children(node) {
  const out = [];
  for (const value of Object.values(node?.subModels || {})) {
    for (const child of Array.isArray(value) ? value : [value]) if (child) out.push(child);
  }
  return out;
}

function findNode(node, predicate) {
  if (!node) return null;
  if (predicate(node)) return node;
  for (const child of children(node)) {
    const found = findNode(child, predicate);
    if (found) return found;
  }
  return null;
}

const collectionOf = (node) => node?.stepParams?.resourceSettings?.init?.collectionName;
const isTable = (node, collection) => node?.use === 'TableBlockModel' && collectionOf(node) === collection;

function findAppointmentsTable(pageTree) {
  return findNode(pageTree, (node) => isTable(node, 'appointments'));
}

// A row action (View / Edit / Delete) of a table, read from its actions column.
function findRowAction(table, use) {
  const actionsColumn = (table?.subModels?.columns || []).find((column) => column.use === 'TableActionsColumnModel');
  return (actionsColumn?.subModels?.actions || []).find((action) => action.use === use) || null;
}

// The grid of a surface whose direct items include every given predicate, in the given order.
function findGridWithItems(tree, predicates) {
  const grid = findNode(tree, (node) => {
    if (node.use !== 'BlockGridModel') return false;
    const items = node.subModels?.items || [];
    return predicates.every((predicate) => items.some(predicate));
  });
  if (!grid) return null;
  const items = grid.subModels.items;
  return { gridUid: grid.uid, order: predicates.map((predicate) => items.find(predicate).uid) };
}

// Page grid: toolbar (JS block) above the appointments table.
function findPageLayoutTarget(pageTree) {
  return findGridWithItems(pageTree, [(node) => node.use === 'JSBlockModel', (node) => isTable(node, 'appointments')]);
}

// View popup grid: appointment details above the booked-services table.
function findDetailsLayoutTarget(popupTree) {
  return findGridWithItems(popupTree, [
    (node) => node.use === 'DetailsBlockModel',
    (node) => isTable(node, 'appointmentServices'),
  ]);
}

// Reads a grid node back as rows of cells of uids, in row order.
function describeGridRows(gridNode) {
  const rows = gridNode?.props?.rows || {};
  const order = gridNode?.props?.rowOrder || Object.keys(rows);
  return order.map((key) => ({ key, cells: rows[key] || [], sizes: gridNode?.props?.sizes?.[key] || [] }));
}

// True when every row holds exactly one full-width cell and the uids appear in the given order.
function isStacked(gridNode, orderedUids) {
  const rows = describeGridRows(gridNode);
  if (rows.length !== orderedUids.length) return false;
  return rows.every(
    (row, index) =>
      row.cells.length === 1 &&
      row.cells[0].length === 1 &&
      row.cells[0][0] === orderedUids[index] &&
      row.sizes.length === 1 &&
      row.sizes[0] === FULL_WIDTH,
  );
}

// True when the given item sits alone in its row at full width (used for the services sub-table).
function isFullWidthRow(gridNode, uid) {
  return describeGridRows(gridNode).some(
    (row) =>
      row.cells.length === 1 && row.cells[0].length === 1 && row.cells[0][0] === uid && row.sizes[0] === FULL_WIDTH,
  );
}

module.exports = {
  FULL_WIDTH,
  describeGridRows,
  findAppointmentsTable,
  findDetailsLayoutTarget,
  findGridWithItems,
  findNode,
  findPageLayoutTarget,
  findRowAction,
  isFullWidthRow,
  isStacked,
  stackedLayout,
};
