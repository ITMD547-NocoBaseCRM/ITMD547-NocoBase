// Tests for the T-05 customer reviews UI scripts and the apply-script helpers (no running NocoBase needed).
// Run: yarn test:customer-reviews
//
// The JS-block scripts are evaluated with a stand-in for NocoBase's `ctx` (React, antd, a fake API that records
// requests), rendered in jsdom with Testing Library, the same way the appointments UI tests work.

const test = require('node:test');
const assert = require('node:assert/strict');
const { installDom } = require('./test-support/jsdom-env');

installDom();

const React = require('react');
const antd = require('antd');
const { act, cleanup, fireEvent, render, screen, waitFor } = require('@testing-library/react');
const {
  CALL_ANCHOR,
  SECTION_BEGIN,
  SECTION_CALL,
  patchStatisticsCode,
  readUi,
  reviewWorkflowDefinition,
  reviewWorkflowNode,
  unpatchStatisticsCode,
} = require('./customer-reviews');
const { findInTree } = require('./apply-customer-reviews');

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const settle = async (ms = 30) => act(async () => new Promise((r) => setTimeout(r, ms)));
test.afterEach(() => cleanup());

// ------------------------------------------------------------------ workflow definition
test('workflow fires only when an appointment update changes status to completed, asynchronously', () => {
  const wf = reviewWorkflowDefinition();
  assert.equal(wf.type, 'collection');
  assert.equal(wf.config.collection, 'appointments');
  assert.equal(wf.config.mode, 2, 'update only: creating an appointment as completed (imports) does not invite');
  assert.deepEqual(wf.config.changed, ['status'], 'editing a completed appointment without a status change does not trigger');
  assert.deepEqual(wf.config.condition, { $and: [{ status: { $eq: 'completed' } }] });
  assert.equal(wf.sync, false);
  assert.deepEqual(reviewWorkflowNode(), { type: 'customerReviewInvitations', title: 'Send review invitations', config: {} });
});

// ------------------------------------------------------------------ Staff Performance patch
const FAKE_STATS = [
  "// BW-STATS v5",
  "const BW_VIEW = 'staff';",
  'function Section({ title, sub, children, extra }) { return h("section", null, title, children); }',
  'function StaffPerformance({ inst, range, rangeText, oneCol, reload }) {',
  "  const who = 'all'; const ref = null; const calc = null; const selector = null; const body = null;",
  `  return h('div', null, ${CALL_ANCHOR}`,
  "    h(Typography.Text, null, 'note'));",
  '}',
  'ctx.render(h(StaffPerformance));',
].join('\n');

test('statistics patch adds the section and one render call, and nothing else', () => {
  const { code, changed } = patchStatisticsCode(FAKE_STATS);
  assert.ok(changed);
  assert.equal(code.split(SECTION_BEGIN).length - 1, 1);
  assert.equal(code.split(SECTION_CALL).length - 1, 1);
  assert.ok(code.indexOf('function BwReviewScores(') < code.indexOf('function StaffPerformance('));
  // Every original line is still there, in order.
  const stripped = unpatchStatisticsCode(code).code;
  assert.equal(stripped, FAKE_STATS);
});

test('statistics patch is idempotent and refreshes an outdated section in place', () => {
  const once = patchStatisticsCode(FAKE_STATS).code;
  const twice = patchStatisticsCode(once);
  assert.equal(twice.changed, false);
  assert.equal(twice.code, once);
  const older = once.replace('staff-review-scores v2', 'staff-review-scores v1');
  const refreshed = patchStatisticsCode(older);
  assert.ok(refreshed.changed);
  assert.equal(refreshed.code, once);
});

test('statistics patch refuses blocks it does not recognise', () => {
  assert.throws(() => patchStatisticsCode(FAKE_STATS.replace("'staff'", "'earnings'")), /Staff Performance/);
  assert.throws(() => patchStatisticsCode(FAKE_STATS.replace(CALL_ANCHOR, 'body,')), /Expected exactly one/);
  assert.throws(() => patchStatisticsCode(`${FAKE_STATS}\n${SECTION_BEGIN} broken`), /end marker/);
});

// ------------------------------------------------------------------ Client Review Scores section
function mountScores({ scores = { minRankable: 5, staff: [] }, who = 'all', techs, fail } = {}) {
  const requests = [];
  const token = { colorBorder: '#ddd', colorBorderSecondary: '#eee', colorTextSecondary: '#555', colorTextTertiary: '#777', colorFillSecondary: '#f5f5f5', borderRadius: 6 };
  const ctx = {
    api: {
      request: async (config) => {
        requests.push(config);
        if (fail) throw Object.assign(new Error('nope'), { response: { status: fail } });
        return { data: { data: scores } };
      },
    },
  };
  const scope = {
    h: React.createElement,
    useState: React.useState,
    useEffect: React.useEffect,
    useMemo: React.useMemo,
    useRef: React.useRef,
    theme: { useToken: () => ({ token }) },
    Section: ({ title, sub, children }) => React.createElement('section', { 'aria-label': title }, React.createElement('h3', null, title), React.createElement('p', null, sub), children),
    Empty: Object.assign(({ description }) => React.createElement('div', null, description), { PRESENTED_IMAGE_SIMPLE: null }),
    Spin: () => React.createElement('span', null, 'loading'),
    Alert: ({ message }) => React.createElement('div', { role: 'alert' }, message),
    Typography: { Text: ({ children }) => React.createElement('span', null, children) },
    bwStaffName: (s) => [s.firstName, s.lastName].filter(Boolean).join(' '),
    ctx,
  };
  const factory = new Function(...Object.keys(scope), `${readUi('staff-review-scores.js')}\nreturn BwReviewScores;`);
  const BwReviewScores = factory(...Object.values(scope));
  const inst = { from: Date.parse('2026-11-01T05:00:00Z'), to: Date.parse('2026-12-01T06:00:00Z') };
  const props = {
    inst,
    who,
    staff: [{ id: 1, firstName: 'Grace', lastName: 'Kim' }, { id: 2, firstName: 'Marcus', lastName: 'Reed' }, { id: 9, firstName: 'Ria', lastName: 'Desk' }],
    techs: techs || [{ key: '1', name: 'Grace Kim' }, { key: '2', name: 'Marcus Reed' }],
    rangeText: 'Nov 1–30, 2026',
    oneCol: false,
    reload: 0,
  };
  const view = render(React.createElement(BwReviewScores, props));
  return { view, requests };
}

test('scores: averages to one decimal with counts, stars and distribution; zero-review technicians say "No reviews yet"', async () => {
  const { requests } = mountScores({ scores: { minRankable: 5, staff: [{ staffId: '1', count: 3, sum: 13, distribution: [0, 0, 0, 2, 1], flagged: 1 }] } });
  await settle();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'customerReviewAdmin:scores');
  assert.deepEqual(requests[0].data, { from: '2026-11-01T05:00:00.000Z', to: '2026-12-01T06:00:00.000Z', staffId: 'all' });
  const grace = screen.getByLabelText('Grace Kim: 4.3 out of 5 from 3 reviews');
  assert.ok(grace.textContent.includes('(3 reviews)'));
  assert.ok(grace.textContent.includes('Few reviews'));
  assert.ok(grace.textContent.includes('1 flagged'));
  assert.ok(screen.getByText('Marcus Reed').parentElement.textContent.includes('No reviews yet'));
  assert.ok(!document.body.textContent.includes('0.0'), 'a technician without reviews is never shown as 0 stars');
  assert.ok(document.body.textContent.includes('out of 5 from 3 reviews across all technicians'));
});

test('scores: empty range shows "No reviews yet" and no zero rating', async () => {
  mountScores();
  await settle();
  assert.ok(screen.getByText('No reviews yet'));
  assert.ok(!document.body.textContent.match(/\b0\.0\b/));
});

test('scores: the technician filter is passed to the server and limits the rows; reviewed non-technicians still appear for All', async () => {
  const one = mountScores({ who: '2', scores: { minRankable: 5, staff: [{ staffId: '2', count: 6, sum: 30, distribution: [0, 0, 0, 0, 6], flagged: 0 }] } });
  await settle();
  assert.equal(one.requests[0].data.staffId, '2');
  assert.ok(screen.getByLabelText('Marcus Reed: 5.0 out of 5 from 6 reviews'));
  assert.equal(screen.queryByText('Grace Kim'), null);
  cleanup();
  mountScores({ scores: { minRankable: 5, staff: [{ staffId: '9', count: 1, sum: 2, distribution: [0, 1, 0, 0, 0], flagged: 0 }] } });
  await settle();
  assert.ok(screen.getByLabelText('Ria Desk: 2.0 out of 5 from 1 reviews'), 'negative reviews are shown, not hidden');
});

test('scores: permission errors are explained, not shown as empty data', async () => {
  mountScores({ fail: 403 });
  await settle();
  assert.match(screen.getByRole('alert').textContent, /permission/);
});

// ------------------------------------------------------------------ appointment panel
const SUMMARY = {
  appointmentId: '42',
  status: 'completed',
  reviewable: true,
  email: { allowed: false, reason: 'transactional_opt_out', message: 'The customer has not opted in to transactional email.' },
  technicians: [{ staffId: '7', name: 'Grace Kim', review: null, invitations: [] }],
  deliveries: [{ id: 'd1', trigger: 'workflow', status: 'skipped', skipReason: 'transactional_opt_out', skipMessage: 'The customer has not opted in to transactional email.', createdAt: '2026-11-19T15:00:00Z' }],
};

async function mountPanel({ summary = SUMMARY, status, onAction } = {}) {
  const requests = [];
  let element;
  const ctx = {
    libs: { React, antd },
    getVar: async (p) => (p === 'ctx.popup.record' ? { id: 42 } : undefined),
    api: {
      request: async (config) => {
        requests.push(config);
        if (status) throw Object.assign(new Error('denied'), { response: { status } });
        if (config.url.endsWith(':appointmentSummary')) return { data: { data: summary } };
        return { data: { data: onAction ? onAction(config) : {} } };
      },
    },
    render: (node) => {
      element = node;
    },
  };
  await new AsyncFunction('ctx', readUi('appointment-review-invitations.js'))(ctx);
  const view = element ? render(element) : null;
  await settle();
  return { view, requests };
}

test('panel: reads the appointment from the popup and explains a skipped email, offering the manual link', async () => {
  const { requests } = await mountPanel();
  assert.deepEqual(requests[0].data, { appointmentId: '42' });
  assert.ok(screen.getByText('Review emails are not sent to this customer'));
  assert.ok(document.body.textContent.includes('Never enable consent'));
  assert.ok(screen.getByText('Automatic invitation skipped: The customer has not opted in to transactional email.'));
  assert.ok(screen.getByRole('button', { name: 'Create link to share' }));
  assert.equal(screen.queryByRole('button', { name: 'Send review invitation now' }), null, 'no email button when email is not allowed');
});

test('panel: is invisible to roles without review permission', async () => {
  const { view } = await mountPanel({ status: 403 });
  assert.equal(view.container.textContent, '');
});

test('panel: manual link is shown once in a dialog after confirmation', async () => {
  const url = 'http://localhost:13000/review#t=' + 'A'.repeat(43);
  const { requests } = await mountPanel({ onAction: (c) => (c.url.endsWith(':manualLink') ? { url, technicianName: 'Grace Kim', expiresAt: '2026-11-26T15:00:00Z', emailAllowed: false, emailNote: 'No consent.' } : {}) });
  fireEvent.click(screen.getByRole('button', { name: 'Create link to share' }));
  await settle();
  fireEvent.click(await screen.findByRole('button', { name: /OK/ }));
  await settle(60);
  const call = requests.find((r) => r.url === 'customerReviewAdmin:manualLink');
  assert.deepEqual(call.data, { appointmentId: '42', staffId: '7' });
  await waitFor(() => assert.equal(screen.getByLabelText('Review link').value, url));
});

test('panel: an emailed, failed invitation offers Retry and Revoke and shows the sanitized error', async () => {
  const summary = {
    ...SUMMARY,
    email: { allowed: true },
    technicians: [{ staffId: '7', name: 'Grace Kim', review: null, invitations: [{ id: 'i1', state: 'active', channel: 'email', deliveryStatus: 'failed', deliveryId: 'd2', expiresAt: '2026-11-26T15:00:00Z', sendAttempts: 1, lastSendError: 'Invalid login' }] }],
  };
  await mountPanel({ summary });
  assert.ok(screen.getByRole('button', { name: 'Retry email' }));
  assert.ok(screen.getByRole('button', { name: 'Revoke' }));
  assert.ok(screen.getByText('Invalid login'));
  assert.ok(screen.getByText('Email failed'));
});

test('panel: a submitted review is shown with its rating and no action buttons', async () => {
  const summary = {
    ...SUMMARY,
    email: { allowed: true },
    technicians: [{ staffId: '7', name: 'Grace Kim', review: { rating: 4, comment: 'Lovely', status: 'submitted', submittedAt: '2026-11-19T16:00:00Z' }, invitations: [{ id: 'i1', state: 'used', channel: 'email', deliveryStatus: 'sent', usedAt: '2026-11-19T16:00:00Z' }] }],
  };
  await mountPanel({ summary });
  assert.ok(screen.getByLabelText('4 of 5 stars'));
  assert.ok(screen.getByText('Lovely'));
  assert.equal(screen.queryByRole('button', { name: /Revoke|Retry|Resend|Create link/ }), null);
});

// ------------------------------------------------------------------ reviews admin page
async function mountAdmin({ status, rows = [] } = {}) {
  const requests = [];
  let element;
  const ctx = {
    libs: { React, antd },
    api: {
      request: async (config) => {
        requests.push(config);
        if (status) throw Object.assign(new Error('denied'), { response: { status } });
        if (config.url === 'customerReviewAdmin:listReviews') return { data: { data: rows, meta: { count: rows.length, page: 1, pageSize: 20, staffOptions: [{ id: '7', name: 'Grace Kim' }] } } };
        return { data: { data: { status: 'flagged' } } };
      },
    },
    render: (node) => {
      element = node;
    },
  };
  await new AsyncFunction('ctx', readUi('customer-reviews-admin.js'))(ctx);
  render(element);
  await settle(60);
  return { requests };
}

test('admin page: non-managers get an explanation instead of data', async () => {
  await mountAdmin({ status: 403 });
  assert.ok(screen.getByText('Customer reviews are available to administrators and managers.'));
});

test('admin page: lists reviews exactly as submitted; flagging needs a reason and goes through moderate', async () => {
  const rows = [{ id: 'r1', rating: 2, comment: 'Too rushed', status: 'submitted', submittedAt: '2026-11-19T16:00:00Z', staff: { firstName: 'Grace', lastName: 'Kim' }, customer: { firstName: 'Ana', lastName: 'Lopez' }, appointment: { appointmentDate: '2026-11-18' }, moderationEvents: [] }];
  const { requests } = await mountAdmin({ rows });
  const list = requests.find((r) => r.url === 'customerReviewAdmin:listReviews');
  assert.deepEqual(list.data, { page: 1, pageSize: 20, staffId: 'all', rating: 'all', status: 'all', from: null, to: null, q: '' });
  assert.equal(requests.filter((r) => /^(staff|customers|appointments|customer_reviews):/.test(r.url)).length, 0, 'no direct collection requests (flowSurfaces RunJS rule)');
  assert.ok(screen.getByText('Too rushed'));
  assert.ok(screen.getByText('Grace Kim'));
  assert.ok(screen.getByText('Ana Lopez'));
  assert.ok(screen.getByText('2026-11-18'));
  assert.ok(screen.getByLabelText('2 of 5 stars'));
  fireEvent.click(screen.getByRole('button', { name: 'Flag' }));
  await settle();
  fireEvent.click(screen.getByRole('button', { name: 'Flag review' }));
  await settle();
  assert.equal(requests.filter((r) => r.url === 'customerReviewAdmin:moderate').length, 0, 'no reason, no request');
  fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Mentions another client by name' } });
  fireEvent.click(screen.getByRole('button', { name: 'Flag review' }));
  await settle(60);
  const mod = requests.find((r) => r.url === 'customerReviewAdmin:moderate');
  assert.deepEqual(mod.data, { reviewId: 'r1', action: 'flag', reason: 'Mentions another client by name' });
});

// ------------------------------------------------------------------ helpers
test('findInTree walks subModels arrays and objects', () => {
  const tree = { use: 'Page', subModels: { tabs: [{ use: 'Tab', subModels: { grid: { use: 'BlockGridModel', uid: 'g1', subModels: { items: [{ use: 'JSBlockModel', uid: 'b1' }] } } } }] } };
  assert.equal(findInTree(tree, (n) => n.use === 'BlockGridModel').uid, 'g1');
  assert.equal(findInTree(tree, (n) => n.uid === 'b1').use, 'JSBlockModel');
  assert.equal(findInTree(tree, (n) => n.uid === 'zz'), null);
});

test('JS blocks never call collection endpoints with ctx.api.request (flowSurfaces RunJS validation); everything goes through customerReviewAdmin', () => {
  for (const f of ['appointment-review-invitations.js', 'customer-reviews-admin.js', 'staff-review-scores.js']) {
    const code = readUi(f);
    for (const m of code.matchAll(/url: ['`]([A-Za-z_]+):([A-Za-z$]+)/g)) {
      const [, resource, action] = m;
      assert.equal(resource, 'customerReviewAdmin', `${f}: JS blocks must not call collection endpoints through ctx.api.request (${resource}:${action})`);
    }
    assert.ok(!/customer_review[a-z_]*:(moderate|scores|appointmentSummary|manualLink|resend|revoke|regenerate|sendNow)/.test(code), f);
  }
});

test('UI scripts render through ctx.render and carry their markers', () => {
  assert.match(readUi('appointment-review-invitations.js'), /BW-REVIEWS appointment-panel/);
  assert.match(readUi('customer-reviews-admin.js'), /BW-REVIEWS admin-page/);
  for (const f of ['appointment-review-invitations.js', 'customer-reviews-admin.js']) assert.ok(readUi(f).includes('ctx.render('));
  assert.ok(readUi('staff-review-scores.js').startsWith(SECTION_BEGIN));
});
