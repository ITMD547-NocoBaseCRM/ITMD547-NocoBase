// Customer activity filters: what is applied to NocoBase (pure definitions, unit-tested; no network here).
//
//   * the read-only view collection `customerActivity` over the database view of the same name
//     (scripts/migrations/20261013_customer_activity.sql), with a belongsTo back to the customer, and the hasOne
//     relation customers.activity -> customerActivity (live numbers, usable in filters and reports);
//   * the activity columns on `customers` (scripts/migrations/20261013_customer_activity_columns.sql) that the
//     Customers table filters and sorts by: NocoBase 2.2 cannot sort through a relation, so the view's values are
//     cached on the customer row by triggers and refreshed nightly;
//   * the scheduled workflow that does the nightly refresh;
//   * the Customers page toolbar script with the shared activity rules injected;
//   * the activity columns the Customers table shows.
//
// `yarn apply:customer-activity` (scripts/apply-customer-activity.js) applies all of it idempotently.

const fs = require('fs');
const path = require('path');
const RULES = require('./customer-activity-rules');

const PAGE_SCHEMA_UID = '04qxi76dv2b'; // "Customers" page under the Salon Management menu group
const VIEW_NAME = 'customerActivity';
const RELATION_NAME = 'activity';
const REFRESH_FUNCTION_SQL = 'SELECT customers_refresh_activity();';
const REFRESH_WORKFLOW_TITLE = 'Refresh customer activity';
const TOOLBAR_SCRIPT_PATH = path.join(__dirname, 'ui', 'customers-toolbar.js');
const RULES_SCRIPT_PATH = path.join(__dirname, 'customer-activity-rules.js');
const RULES_PLACEHOLDER = '/*CUSTOMER_ACTIVITY_RULES*/';

const readOnlyNumber = (title, props = {}) => ({
  type: 'number',
  title,
  'x-component': 'InputNumber',
  'x-component-props': props,
  'x-read-pretty': true,
});
const readOnlyDate = (title) => ({
  type: 'string',
  title,
  'x-component': 'DatePicker',
  'x-component-props': { showTime: true, utc: true },
  'x-read-pretty': true,
});
const integer = (name, title, extra = {}) => ({ name, type: 'integer', interface: 'integer', uiSchema: readOnlyNumber(title), ...extra });
const money = (name, title) => ({ name, type: 'decimal', interface: 'number', precision: 12, scale: 2, defaultValue: 0, uiSchema: readOnlyNumber(title, { step: '0.01' }) });
const datetime = (name, title) => ({ name, type: 'date', interface: 'datetime', uiSchema: readOnlyDate(title) });
const WINDOWS = [1, 2, 3, 4, 5, 6, 12];
const windowTitle = (n) => `Visits, last ${n === 1 ? 'month' : `${n} months`}`;

// Field list of the view collection. Names must match the view's columns exactly.
function viewFields() {
  return [
    { name: 'id', type: 'bigInt', interface: 'integer', primaryKey: true, source: 'customers.id', uiSchema: readOnlyNumber('ID') },
    { name: 'customerId', type: 'bigInt', interface: 'integer', source: 'customers.id', uiSchema: readOnlyNumber('Customer ID') },
    integer('totalVisits', 'Completed visits'),
    datetime('firstVisitAt', 'First visit'),
    datetime('lastVisitAt', 'Last visit'),
    integer('daysSinceLastVisit', 'Days since last visit'),
    ...WINDOWS.map((n) => integer(`visitsLast${n}m`, windowTitle(n))),
    { name: 'totalSpent', type: 'decimal', interface: 'number', uiSchema: readOnlyNumber('Total spent', { step: '0.01' }) },
    { name: 'spentLast12m', type: 'decimal', interface: 'number', uiSchema: readOnlyNumber('Spent, last 12 months', { step: '0.01' }) },
    {
      name: 'customer',
      type: 'belongsTo',
      interface: 'm2o',
      target: 'customers',
      foreignKey: 'customerId',
      targetKey: 'id',
      uiSchema: {
        type: 'object',
        title: 'Customer',
        'x-component': 'AssociationField',
        'x-component-props': { multiple: false, fieldNames: { value: 'id', label: 'firstName' } },
      },
    },
  ];
}

// Payload for collections:create. A view collection is read-only: NocoBase refuses create/update/destroy on it.
function viewCollectionDefinition() {
  return {
    name: VIEW_NAME,
    title: 'Customer activity',
    template: 'view',
    view: true,
    viewName: VIEW_NAME,
    schema: 'public',
    writableView: false,
    filterTargetKey: 'id',
    autoGenId: false,
    timestamps: false,
    logging: false,
    description:
      'One row per customer, computed live from completed appointments and paid payments: first and last visit, visit counts for rolling periods, net spending. Read-only. Reached from customers.activity.',
    fields: viewFields(),
  };
}

// Payload for collections/customers/fields:create: the hasOne relation to the live view.
function activityRelationDefinition() {
  return {
    name: RELATION_NAME,
    type: 'hasOne',
    interface: 'oho',
    target: VIEW_NAME,
    foreignKey: 'customerId',
    sourceKey: 'id',
    description: 'Visit history and spending, computed live (read-only view)',
    uiSchema: {
      type: 'object',
      title: 'Activity',
      'x-component': 'AssociationField',
      'x-component-props': { multiple: false, fieldNames: { value: 'id', label: 'totalVisits' } },
    },
  };
}

// The cached activity columns on customers (the database columns exist from the migration; this is their NocoBase
// metadata, one fields:create each). visitCount already exists as a field.
function customerActivityFields() {
  const note = 'Kept up to date automatically from completed appointments and payments';
  return [
    datetime('firstVisitAt', 'First visit'),
    datetime('lastVisitAt', 'Last visit'),
    money('totalSpent', 'Total spent'),
    ...WINDOWS.map((n) => integer(`visitsLast${n}m`, windowTitle(n), { defaultValue: 0 })),
    datetime('activityRefreshedAt', 'Activity refreshed at'),
  ].map((field) => ({ ...field, description: note }));
}

// Nightly refresh of the cached columns: a static schedule workflow with one SQL node.
function refreshWorkflowDefinition() {
  return {
    title: REFRESH_WORKFLOW_TITLE,
    type: 'schedule',
    enabled: true,
    description:
      'Refreshes the customer activity columns (last visit, visit counts for rolling periods, spending) every night at 03:00 server time so "inactive for N months" style filters move with the calendar. Triggers refresh the same columns immediately when an appointment or payment changes.',
    config: { mode: 0, startsOn: '2026-10-13T03:00:00.000Z', repeat: '0 3 * * *' },
  };
}
function refreshWorkflowNodeDefinition() {
  return {
    type: 'sql',
    title: 'Refresh activity columns',
    config: { dataSource: 'main', sql: REFRESH_FUNCTION_SQL, withMeta: false },
  };
}

// Columns added to the Customers table (fieldPath -> label). visitCount is already a column ("Visits").
const TABLE_COLUMNS = [
  { fieldPath: 'lastVisitAt', label: 'Last visit' },
  { fieldPath: 'totalSpent', label: 'Total spent' },
];

// The toolbar script with the shared rules injected in place of the placeholder (a replacer function keeps "$"
// sequences such as "$gte" literal).
function readRulesScript() {
  return fs.readFileSync(RULES_SCRIPT_PATH, 'utf8');
}
// The Node export line is dropped for the browser: NocoBase's RunJS validator rejects any reference to `module`.
const NODE_EXPORT_LINE = /^if \(typeof module !== 'undefined'.*$/m;
function readRulesScriptForBrowser() {
  const source = readRulesScript();
  if (!NODE_EXPORT_LINE.test(source)) throw new Error(`${RULES_SCRIPT_PATH} is missing its module.exports line`);
  return source.replace(NODE_EXPORT_LINE, '');
}
// The Send message dialog's settings (outbox collection, email channel name, page title) come from
// scripts/customer-messaging.js so the toolbar and the apply scripts cannot disagree.
const MESSAGING_PLACEHOLDER = /\/\*CUSTOMER_MESSAGING\*\/\{[^\n]*?\};/;
function messagingConfig() {
  const m = require('./customer-messaging');
  return { collection: m.MESSAGES_COLLECTION, emailChannel: m.EMAIL_CHANNEL_NAME, pageTitle: m.MESSAGES_PAGE_TITLE };
}
function readToolbarScript() {
  const source = fs.readFileSync(TOOLBAR_SCRIPT_PATH, 'utf8');
  if (!source.includes(RULES_PLACEHOLDER)) throw new Error(`${TOOLBAR_SCRIPT_PATH} is missing the ${RULES_PLACEHOLDER} placeholder`);
  if (!MESSAGING_PLACEHOLDER.test(source)) throw new Error(`${TOOLBAR_SCRIPT_PATH} is missing the CUSTOMER_MESSAGING placeholder`);
  return source
    .replace(RULES_PLACEHOLDER, () => readRulesScriptForBrowser())
    .replace(MESSAGING_PLACEHOLDER, () => `${JSON.stringify(messagingConfig())};`);
}

// Every customers field the rules and sorts reference, so a typo is caught by the tests instead of in the browser.
function referencedCustomerFields() {
  const names = new Set();
  const collect = (value) => {
    if (Array.isArray(value)) return value.forEach(collect);
    if (!value || typeof value !== 'object') return;
    for (const [key, inner] of Object.entries(value)) {
      if (!key.startsWith('$')) names.add(key);
      collect(inner);
    }
  };
  for (const months of RULES.PERIODS.map((p) => p.value)) {
    for (const activity of RULES.ACTIVITIES) collect(RULES.filter({ activity: activity.key, months, now: new Date() }));
    for (const sort of RULES.SORTS) for (const key of RULES.sort({ sort: sort.value, months })) names.add(key.replace(/^-/, ''));
  }
  return [...names].sort();
}

module.exports = {
  PAGE_SCHEMA_UID,
  REFRESH_FUNCTION_SQL,
  REFRESH_WORKFLOW_TITLE,
  RELATION_NAME,
  RULES_PLACEHOLDER,
  RULES_SCRIPT_PATH,
  TABLE_COLUMNS,
  TOOLBAR_SCRIPT_PATH,
  VIEW_NAME,
  WINDOWS,
  activityRelationDefinition,
  customerActivityFields,
  readRulesScript,
  readRulesScriptForBrowser,
  readToolbarScript,
  referencedCustomerFields,
  refreshWorkflowDefinition,
  refreshWorkflowNodeDefinition,
  viewCollectionDefinition,
  viewFields,
};
