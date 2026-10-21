// Unit tests for the customer activity filters: the rules, the definitions applied to NocoBase and the toolbar script.
// Run with `yarn test:customer-activity` (node:test, no app or database needed).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const RULES = require('./customer-activity-rules');
const page = require('./customer-activity-page');

const NOW = new Date('2026-10-13T12:00:00.000Z');
const flat = (filter) => JSON.stringify(filter);
const readMigration = (name) => fs.readFileSync(path.join(__dirname, 'migrations', name), 'utf8');

test('time periods are the six rolling months and the cutoff is the same day N months earlier', () => {
  assert.deepEqual(RULES.PERIODS.map((p) => p.value), [1, 2, 3, 4, 5, 6, 12]);
  assert.deepEqual(RULES.filter({ activity: 'mostActive', months: 12, now: NOW }), { visitsLast12m: { $gte: 1 } });
  assert.equal(RULES.cutoffISO(NOW, 12), '2025-10-13T12:00:00.000Z');
  assert.equal(RULES.cutoffISO(NOW, 3), '2026-07-13T12:00:00.000Z');
  assert.equal(RULES.cutoffISO(NOW, 1), '2026-09-13T12:00:00.000Z');
  // 31 March minus one month is the end of February, not 3 March.
  assert.equal(RULES.cutoffISO(new Date('2026-03-31T10:00:00.000Z'), 1), '2026-02-28T10:00:00.000Z');
  assert.equal(RULES.normalizeMonths('4'), 4);
  assert.equal(RULES.normalizeMonths(99), 3, 'an unknown period falls back to 3 months');
});

test('inactive for N+ months: visited before, nothing completed since the cutoff, never-visited excluded', () => {
  const f = RULES.filter({ activity: 'inactive', months: 3, now: NOW });
  assert.deepEqual(f, { $and: [{ visitCount: { $gte: 1 } }, { lastVisitAt: { $lt: '2026-07-13T12:00:00.000Z' } }] });
});

test('last visited N to N+1 months ago is the one-month band between two cutoffs', () => {
  const f = RULES.filter({ activity: 'lastVisitedBetween', months: 3, now: NOW });
  assert.deepEqual(f, {
    $and: [{ lastVisitAt: { $lt: '2026-07-13T12:00:00.000Z' } }, { lastVisitAt: { $gte: '2026-06-13T12:00:00.000Z' } }],
  });
});

test('most active uses the matching rolling count column and sorts by it', () => {
  assert.deepEqual(RULES.filter({ activity: 'mostActive', months: 2, now: NOW }), { visitsLast2m: { $gte: 1 } });
  assert.equal(RULES.defaultSort('mostActive'), 'active');
  assert.deepEqual(RULES.sort({ sort: 'active', months: 2 }), ['-visitsLast2m', '-lastVisitAt', 'firstName']);
});

test('new, one-time, repeat, high-value, never visited and most inactive', () => {
  assert.deepEqual(RULES.filter({ activity: 'new', months: 6, now: NOW }), { firstVisitAt: { $gte: '2026-04-13T12:00:00.000Z' } });
  assert.deepEqual(RULES.filter({ activity: 'oneTime', months: 3, now: NOW }), { visitCount: { $eq: 1 } });
  assert.deepEqual(RULES.filter({ activity: 'repeat', months: 3, now: NOW }), { visitCount: { $gte: 2 } });
  assert.deepEqual(RULES.filter({ activity: 'highValue', months: 3, now: NOW }), { totalSpent: { $gt: 0 } });
  assert.deepEqual(RULES.filter({ activity: 'never', months: 3, now: NOW }), { $or: [{ visitCount: { $eq: 0 } }, { visitCount: { $empty: true } }] });
  assert.deepEqual(RULES.filter({ activity: 'mostInactive', months: 3, now: NOW }), { visitCount: { $gte: 1 } });
  assert.equal(RULES.defaultSort('mostInactive'), 'longest');
  assert.deepEqual(RULES.sort({ sort: 'longest', months: 3 }), ['lastVisitAt', 'firstName']);
  assert.equal(RULES.defaultSort('highValue'), 'spent');
  assert.deepEqual(RULES.filter({ activity: 'all', months: 3, now: NOW }), {});
});

test('at risk: regulars (3+ visits) away for the period but seen within the last 12 months', () => {
  const f = RULES.filter({ activity: 'atRisk', months: 2, now: NOW });
  assert.deepEqual(f, {
    $and: [
      { visitCount: { $gte: 3 } },
      { lastVisitAt: { $lt: '2026-08-13T12:00:00.000Z' } },
      { lastVisitAt: { $gte: '2025-10-13T12:00:00.000Z' } },
    ],
  });
});

test('no rule filters or sorts through a relation (NocoBase 2.2 cannot sort through one)', () => {
  for (const name of page.referencedCustomerFields()) assert.ok(!name.includes('.'), `${name} is a relation path`);
});

test('labels and descriptions follow the selected period and the sort options are complete', () => {
  const labels = Object.fromEntries(RULES.options(4).map((o) => [o.value, o.label]));
  assert.equal(labels.inactive, 'Inactive for 4+ months');
  assert.equal(labels.lastVisitedBetween, 'Last visited 4–5 months ago');
  assert.equal(labels.mostActive, 'Most active in the last 4 months');
  assert.equal(labels.new, 'New in the last 4 months');
  assert.equal(labels.all, 'All customers');
  assert.match(RULES.describe({ activity: 'inactive', months: 3, now: NOW }), /since 2026-07-13 \(3 months or longer\)/);
  assert.match(RULES.describe({ activity: 'lastVisitedBetween', months: 1, now: NOW }), /between 2026-08-13 and 2026-09-13/);
  assert.match(RULES.describe({ activity: 'never', months: 3, now: NOW }), /no completed appointment/);
  assert.deepEqual(RULES.SORTS.map((s) => s.value), ['active', 'recent', 'longest', 'spent', 'newest']);
  assert.equal(RULES.usesPeriod('oneTime', 'recent'), false);
  assert.equal(RULES.usesPeriod('oneTime', 'active'), true, 'the "most active first" sort needs the period');
  assert.equal(RULES.usesPeriod('inactive', 'recent'), true);
});

test('every customers field the rules reference is a registered activity field, visitCount or a base field', () => {
  const activityFields = new Set(page.customerActivityFields().map((f) => f.name));
  const base = new Set(['visitCount', 'createdAt', 'firstName']);
  for (const name of page.referencedCustomerFields()) assert.ok(activityFields.has(name) || base.has(name), `rules reference customers.${name} but nothing registers it`);
  for (const p of RULES.PERIODS) assert.ok(activityFields.has(`visitsLast${p.value}m`), `no visitsLast${p.value}m column for the ${p.label} period`);
  for (const column of page.TABLE_COLUMNS) assert.ok(activityFields.has(column.fieldPath), `table column ${column.fieldPath} is not an activity field`);
});

test('the view collection and relation definitions are consistent with each other', () => {
  const view = page.viewCollectionDefinition();
  assert.equal(view.name, 'customerActivity');
  assert.equal(view.view, true);
  assert.equal(view.viewName, view.name);
  assert.equal(view.writableView, false);
  assert.equal(view.filterTargetKey, 'id');
  assert.ok(view.fields.find((f) => f.name === 'id' && f.primaryKey));
  const back = view.fields.find((f) => f.name === 'customer');
  assert.equal(back.type, 'belongsTo');
  assert.equal(back.target, 'customers');
  const relation = page.activityRelationDefinition();
  assert.equal(relation.type, 'hasOne');
  assert.equal(relation.target, view.name);
  assert.equal(relation.foreignKey, 'customerId');
  assert.equal(relation.sourceKey, 'id');
});

test('the SQL migrations define every column the collection and the customer fields declare', () => {
  const viewSql = readMigration('20261013_customer_activity.sql');
  for (const field of page.viewFields()) {
    if (field.type === 'belongsTo') continue;
    assert.ok(new RegExp(`AS\\s+(")?${field.name}(")?\\b`).test(viewSql), `view has no column ${field.name}`);
  }
  assert.match(viewSql, /CREATE OR REPLACE VIEW "customerActivity"/);
  assert.match(viewSql, /status = 'completed'/);

  const columnsSql = readMigration('20261013_customer_activity_columns.sql');
  for (const field of page.customerActivityFields()) {
    assert.ok(columnsSql.includes(`ADD COLUMN IF NOT EXISTS "${field.name}"`), `customers has no column ${field.name}`);
    if (field.name !== 'activityRefreshedAt') assert.ok(columnsSql.includes(`v."${field.name}"`) || columnsSql.includes(`"${field.name}"        = v.`), `refresh does not copy ${field.name}`);
  }
  assert.match(columnsSql, /CREATE OR REPLACE FUNCTION customers_refresh_activity\(customer_ids BIGINT\[\] DEFAULT NULL\)/);
  assert.match(columnsSql, /CREATE TRIGGER appointments_refresh_customer_activity/);
  assert.match(columnsSql, /CREATE TRIGGER payments_refresh_customer_activity/);
  assert.match(columnsSql, /DROP TRIGGER IF EXISTS appointments_sync_customer_visit_count/);
});

test('the nightly workflow is a static schedule running the refresh function through an SQL node', () => {
  const wf = page.refreshWorkflowDefinition();
  assert.equal(wf.type, 'schedule');
  assert.equal(wf.config.mode, 0);
  assert.equal(wf.config.repeat, '0 3 * * *');
  assert.ok(!Number.isNaN(Date.parse(wf.config.startsOn)));
  const node = page.refreshWorkflowNodeDefinition();
  assert.equal(node.type, 'sql');
  assert.equal(node.config.sql, page.REFRESH_FUNCTION_SQL);
  assert.match(readMigration('20261013_customer_activity_columns.sql'), /customers_refresh_activity\(customer_ids BIGINT\[\] DEFAULT NULL\)/);
});

test('customer messaging definitions are consistent: fields, workflow nodes and the toolbar settings', () => {
  const m = require('./customer-messaging');
  const fields = new Set(m.messagesCollectionDefinition().fields.map((f) => f.name));
  for (const name of ['customer', 'channel', 'recipient', 'subject', 'body', 'bodyHtml', 'status', 'sentAt', 'error', 'batchKey', 'createdAt', 'createdBy']) assert.ok(fields.has(name), `collection lacks ${name}`);
  assert.match(m.emailEnvelope('<p>x</p>'), /^<div style="font-family[^"]*"><p>x<\/p><\/div>$/);
  const nodes = m.deliveryWorkflowNodes({ smsWebhookUrl: 'https://sms.example.com/send', smsAuthHeader: 'Bearer x' });
  const byKey = Object.fromEntries(nodes.map((n) => [n.key, n]));
  for (const n of nodes) if (n.upstream) assert.ok(byKey[n.upstream], `${n.key} has unknown upstream ${n.upstream}`);
  assert.equal(byKey.sendEmail.branch, 1);
  assert.equal(byKey.sendEmail.config.channelName, m.EMAIL_CHANNEL_NAME);
  assert.equal(byKey.sendEmail.config.contentType, 'html');
  assert.equal(byKey.sendEmail.config.html, '{{$context.data.bodyHtml}}');
  assert.equal(byKey.sendSms.config.url, 'https://sms.example.com/send');
  assert.deepEqual(byKey.sendSms.config.headers, [{ name: 'Authorization', value: 'Bearer x' }]);
  assert.equal(byKey.isEmail.config.calculation.group.calculations[0].operands[1], 'email');
  const twilio = m.smsNodeConfig({ smsProvider: 'twilio', twilio: { accountSid: 'ACxyz', authToken: 'tok', from: '+13125550100' } });
  assert.equal(twilio.url, 'https://api.twilio.com/2010-04-01/Accounts/ACxyz/Messages.json');
  assert.equal(twilio.contentType, 'application/x-www-form-urlencoded');
  assert.equal(twilio.headers[0].value, 'Basic ' + Buffer.from('ACxyz:tok').toString('base64'));
  assert.deepEqual(twilio.data.map((d) => d.name), ['To', 'From', 'Body']);
  assert.throws(() => m.smsNodeConfig({ smsProvider: 'twilio', twilio: { accountSid: 'ACxyz' } }), /Twilio needs/);
  // Every {{$context.data.x}} variable the nodes use is a real field of the collection (or its id).
  const used = [...JSON.stringify(nodes).matchAll(/\{\{\$context\.data\.([a-zA-Z]+)\}\}/g)].map((x) => x[1]);
  for (const name of used) assert.ok(fields.has(name) || ['id', 'customerId'].includes(name), `workflow references unknown field ${name}`);
  assert.equal(m.renderTemplate('Hi {{firstName}} {{ lastName }} ({{fullName}})', { firstName: 'Mia', lastName: 'Lee' }), 'Hi Mia Lee (Mia Lee)');
  assert.equal(m.renderTemplate('Hi {{firstName}}', {}), 'Hi ');
  const code = page.readToolbarScript();
  assert.ok(code.includes(`"collection":"${m.MESSAGES_COLLECTION}"`) && code.includes(`"emailChannel":"${m.EMAIL_CHANNEL_NAME}"`), 'toolbar does not carry the messaging settings');
  assert.ok(!code.includes('/*CUSTOMER_MESSAGING*/'));
});

test('the toolbar script embeds the rules, has no placeholder left and parses as an async module body', () => {
  const code = page.readToolbarScript();
  assert.ok(!code.includes(page.RULES_PLACEHOLDER));
  assert.ok(code.includes('const CUSTOMER_ACTIVITY = (function ()'));
  assert.ok(code.includes('ctx.render('));
  assert.ok(code.includes('"collection":"customers"'));
  assert.ok(code.includes('"label":"Active"'), 'Active customer metric should be configured');
  assert.ok(code.includes('"label":"At Risk"'), 'At Risk customer metric should be configured');
  assert.ok(code.includes("metricCard('Total'"), 'Total customer metric should be rendered');
  assert.ok(code.includes("' total customers'"), 'customer summary should use the requested title');
  assert.ok(!code.includes('"activity.'), 'the toolbar must not read through the relation');
  assert.ok(!/\bmodule\b/.test(code), 'RunJS rejects any reference to `module`');
  assert.ok(!/\brequire\(/.test(code), 'RunJS has no require()');
  // RunJS runs the code as the body of an async function with `ctx` in scope; a syntax error would only show in the browser.
  assert.doesNotThrow(() => new vm.Script(`(async function (ctx) {\n${code}\n})`, { filename: 'customers-toolbar.generated.js' }));
});

test('the rules script works when evaluated as browser code (no module, no require)', () => {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(`${page.readRulesScriptForBrowser()}\n;globalThis.__out = CUSTOMER_ACTIVITY;`, sandbox);
  assert.equal(typeof sandbox.__out.filter, 'function');
  // Objects from another vm context are never reference-equal, so compare their JSON.
  assert.equal(flat(sandbox.__out.filter({ activity: 'repeat', months: 3, now: NOW })), flat({ visitCount: { $gte: 2 } }));
});
