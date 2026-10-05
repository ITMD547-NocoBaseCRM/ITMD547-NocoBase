const test = require('node:test');
const assert = require('node:assert/strict');
const {
  describeGridRows,
  findForms,
  formGridLayout,
  formItemsByPath,
  missingFormFields,
  findAppointmentsTable,
  findDetailsLayoutTarget,
  findPageLayoutTarget,
  findRowAction,
  isFullWidthRow,
  isStacked,
  stackedLayout,
} = require('./appointments-page-layout');

const table = (uid, collection, extra = {}) => ({
  uid,
  use: 'TableBlockModel',
  stepParams: { resourceSettings: { init: { collectionName: collection } } },
  subModels: extra.subModels || {},
});

const pageTree = {
  uid: 'page',
  use: 'RootPageModel',
  subModels: {
    tabs: [
      {
        uid: 'tab',
        use: 'RootPageTabModel',
        subModels: {
          grid: {
            uid: 'pageGrid',
            use: 'BlockGridModel',
            subModels: {
              items: [
                { uid: 'toolbar', use: 'JSBlockModel' },
                table('apptTable', 'appointments', {
                  subModels: {
                    columns: [
                      {
                        use: 'TableActionsColumnModel',
                        subModels: {
                          actions: [
                            { uid: 'view1', use: 'ViewActionModel' },
                            { uid: 'edit1', use: 'EditActionModel' },
                          ],
                        },
                      },
                    ],
                  },
                }),
              ],
            },
          },
        },
      },
    ],
  },
};

test('stackedLayout puts one full-width block on each row, in order', () => {
  assert.deepEqual(stackedLayout(['a', 'b']), {
    rows: { row1: [['a']], row2: [['b']] },
    sizes: { row1: [24], row2: [24] },
    rowOrder: ['row1', 'row2'],
  });
});

test('finds the page grid by its toolbar and appointments table, in toolbar-first order', () => {
  assert.deepEqual(findPageLayoutTarget(pageTree), { gridUid: 'pageGrid', order: ['toolbar', 'apptTable'] });
  assert.equal(findAppointmentsTable(pageTree).uid, 'apptTable');
  assert.equal(findRowAction(findAppointmentsTable(pageTree), 'ViewActionModel').uid, 'view1');
  assert.equal(findRowAction(findAppointmentsTable(pageTree), 'DeleteActionModel'), null);
});

test('does not match a grid that lacks the toolbar or the table', () => {
  const noToolbar = { uid: 'g', use: 'BlockGridModel', subModels: { items: [table('t', 'appointments')] } };
  assert.equal(findPageLayoutTarget(noToolbar), null);
  const wrongCollection = {
    uid: 'g',
    use: 'BlockGridModel',
    subModels: { items: [{ uid: 'js', use: 'JSBlockModel' }, table('t', 'customers')] },
  };
  assert.equal(findPageLayoutTarget(wrongCollection), null);
});

test('finds the View popup grid by its details block and booked services table', () => {
  const popup = {
    use: 'ViewActionModel',
    subModels: {
      page: {
        use: 'ChildPageModel',
        subModels: {
          tabs: [
            {
              use: 'ChildPageTabModel',
              subModels: {
                grid: {
                  uid: 'popupGrid',
                  use: 'BlockGridModel',
                  subModels: {
                    items: [table('svc', 'appointmentServices'), { uid: 'details', use: 'DetailsBlockModel' }],
                  },
                },
              },
            },
          ],
        },
      },
    },
  };
  // order follows the requested predicates, not the stored order
  assert.deepEqual(findDetailsLayoutTarget(popup), { gridUid: 'popupGrid', order: ['details', 'svc'] });
});

test('isStacked accepts one full-width cell per row in the expected order only', () => {
  const stacked = { props: stackedLayout(['toolbar', 'apptTable']) };
  assert.equal(isStacked(stacked, ['toolbar', 'apptTable']), true);
  assert.equal(isStacked(stacked, ['apptTable', 'toolbar']), false);

  const sideBySide = {
    props: { rows: { row1: [['toolbar'], ['apptTable']] }, sizes: { row1: [12, 12] }, rowOrder: ['row1'] },
  };
  assert.equal(isStacked(sideBySide, ['toolbar', 'apptTable']), false);

  const halfWidth = {
    props: {
      rows: { row1: [['toolbar']], row2: [['apptTable']] },
      sizes: { row1: [12], row2: [24] },
      rowOrder: ['row1', 'row2'],
    },
  };
  assert.equal(isStacked(halfWidth, ['toolbar', 'apptTable']), false);
  assert.equal(isStacked({}, ['toolbar']), false);
});

test('isFullWidthRow finds an item alone on a full-width row', () => {
  const grid = {
    props: {
      rows: { row1: [['customer'], ['category']], row2: [['services']], row3: [['notes']] },
      sizes: { row1: [12, 12], row2: [24], row3: [12] },
      rowOrder: ['row1', 'row2', 'row3'],
    },
  };
  assert.equal(isFullWidthRow(grid, 'services'), true);
  assert.equal(isFullWidthRow(grid, 'customer'), false);
  assert.equal(isFullWidthRow(grid, 'notes'), false);
  assert.deepEqual(
    describeGridRows(grid).map((row) => row.key),
    ['row1', 'row2', 'row3'],
  );
});

const formItem = (uid, path) => ({
  uid,
  use: 'FormItemModel',
  stepParams: { fieldSettings: { init: { fieldPath: path } } },
});
const form = (use, uid, paths) => ({
  uid,
  use,
  subModels: {
    grid: {
      uid: uid + '-grid',
      use: 'FormGridModel',
      subModels: { items: paths.map((path) => formItem('i-' + path, path)) },
    },
  },
});

test('findForms returns create and edit forms, including ones nested inside other popups', () => {
  const tree = {
    use: 'ViewActionModel',
    subModels: {
      page: {
        use: 'ChildPageModel',
        subModels: {
          tabs: [
            {
              use: 'ChildPageTabModel',
              subModels: {
                grid: {
                  use: 'BlockGridModel',
                  subModels: {
                    items: [
                      {
                        use: 'DetailsBlockModel',
                        subModels: {
                          actions: [
                            { use: 'EditActionModel', subModels: { page: form('EditFormModel', 'nested', ['a']) } },
                          ],
                        },
                      },
                    ],
                  },
                },
              },
            },
          ],
        },
      },
    },
  };
  assert.deepEqual(
    findForms(tree).map((node) => node.uid),
    ['nested'],
  );
  assert.deepEqual(
    findForms(form('CreateFormModel', 'top', ['a'])).map((node) => node.uid),
    ['top'],
  );
});

test('missingFormFields reports the wanted fields the form does not show', () => {
  const create = form('CreateFormModel', 'c', ['customer', 'category', 'startTime']);
  assert.deepEqual(formItemsByPath(create), {
    customer: 'i-customer',
    category: 'i-category',
    startTime: 'i-startTime',
  });
  assert.deepEqual(missingFormFields(create, ['customer', 'appointmentDate', 'startTime', 'status']), [
    'appointmentDate',
    'status',
  ]);
  assert.deepEqual(missingFormFields(create, ['customer']), []);
});

test('formGridLayout turns [path, span] rows into one cell per field with the spans per row', () => {
  const layout = formGridLayout(
    [
      [
        ['customer', 12],
        ['category', 12],
      ],
      [['notes', 24]],
    ],
    { customer: 'u1', category: 'u2', notes: 'u3' },
  );
  assert.deepEqual(layout, {
    rows: { row1: [['u1'], ['u2']], row2: [['u3']] },
    sizes: { row1: [12, 12], row2: [24] },
    rowOrder: ['row1', 'row2'],
  });
  assert.throws(() => formGridLayout([[['missing', 24]]], {}), /no item for missing/);
});
