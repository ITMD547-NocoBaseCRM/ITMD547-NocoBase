// Behaviour tests for the Appointments toolbar (US-26 / T-43), run against the real toolbar script.
//
// The script normally runs inside NocoBase's JS block runtime. Here it is evaluated with a faithful
// stand-in for `ctx`: a fake table resource (filter groups, paging, refresh events) and a fake API that
// evaluates the same server filters, so tab filtering, request counts and refresh handling are exercised
// without a browser. The live page is covered separately by `yarn validate:appointments-ui`.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM, VirtualConsole } = require('jsdom');

// --- DOM environment: must exist before React, antd or Testing Library are loaded -----------------
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/admin/7rbhpfmdhv5',
  pretendToBeVisual: true,
  virtualConsole: new VirtualConsole(),
});
const { window } = dom;
// Expose jsdom's DOM classes (SVGElement, KeyboardEvent, ...) the way a jest-style environment does.
for (const name of Object.getOwnPropertyNames(window)) {
  if (/^[A-Z]/.test(name) && !(name in globalThis)) {
    try {
      Object.defineProperty(globalThis, name, { value: window[name], configurable: true, writable: true });
    } catch {
      // read-only host globals are left alone
    }
  }
}
Object.assign(globalThis, {
  window,
  document: window.document,
  HTMLElement: window.HTMLElement,
  Node: window.Node,
  getComputedStyle: window.getComputedStyle.bind(window),
  MutationObserver: window.MutationObserver,
  requestAnimationFrame: (cb) => setTimeout(cb, 0),
  cancelAnimationFrame: (id) => clearTimeout(id),
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
window.matchMedia =
  window.matchMedia ||
  (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
window.ResizeObserver =
  window.ResizeObserver ||
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
globalThis.ResizeObserver = window.ResizeObserver;

const React = require('react');
const antd = require('antd');
const dayjs = require('dayjs');
const { act, cleanup, fireEvent, render, screen, waitFor } = require('@testing-library/react');
const { readToolbarScript } = require('./appointments-page-blueprint');
const { getCategoryFilter } = require('./appointments-schema');

const TOOLBAR_CODE = readToolbarScript();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ROWS = [
  { id: 1, category: 'session', status: 'completed', customer: { firstName: 'Ava' } },
  { id: 2, category: 'session', status: 'completed', customer: { firstName: 'Mia' } },
  { id: 3, category: 'session', status: 'scheduled', customer: { firstName: 'Noah' } },
  { id: 4, category: 'event', status: 'confirmed', customer: { firstName: 'Emma' } },
  { id: 5, category: 'event', status: 'completed', customer: { firstName: 'Liam' } },
];

const getPath = (object, path) => path.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), object);
function matches(row, filter) {
  if (!filter || !Object.keys(filter).length) return true;
  return Object.entries(filter).every(([key, value]) => {
    if (key === '$and') return value.every((item) => matches(row, item));
    if (key === '$or') return value.some((item) => matches(row, item));
    const actual = getPath(row, key);
    return Object.entries(value).every(([op, arg]) => {
      if (op === '$eq') return actual === arg;
      if (op === '$includes')
        return String(actual ?? '')
          .toLowerCase()
          .includes(String(arg).toLowerCase());
      if (op === '$gte') return actual >= arg;
      if (op === '$lte') return actual <= arg;
      return true;
    });
  });
}

function createResource() {
  const listeners = new Map();
  const resource = {
    loading: false,
    page: 1,
    filterGroups: {},
    refreshCalls: 0,
    addFilterGroup(key, filter) {
      this.filterGroups[key] = filter;
    },
    removeFilterGroup(key) {
      delete this.filterGroups[key];
    },
    setPage(page) {
      this.page = page;
    },
    getPage() {
      return this.page;
    },
    on(event, cb) {
      listeners.set(event, [...(listeners.get(event) || []), cb]);
    },
    off(event, cb) {
      listeners.set(
        event,
        (listeners.get(event) || []).filter((item) => item !== cb),
      );
    },
    emit(event) {
      (listeners.get(event) || []).forEach((cb) => cb());
    },
    listenerCount: (event) => (listeners.get(event) || []).length,
    async refresh() {
      this.refreshCalls += 1;
      await sleep(5);
      this.emit('refresh');
    },
  };
  return resource;
}

// Evaluates the toolbar script with a fake runtime and renders what it passes to ctx.render().
function mount({ rows = ROWS, search = '' } = {}) {
  window.history.replaceState(null, '', '/admin/7rbhpfmdhv5' + search);
  const resource = createResource();
  const calls = [];
  const navigations = [];
  const data = structuredClone(rows); // tests edit these rows; never share them between tests
  const table = {
    resource,
    collection: { name: 'appointments' },
    getStepParams: () => ({ collectionName: 'appointments' }),
  };
  const fields = [
    {
      name: 'category',
      interface: 'select',
      enum: [
        { value: 'session', label: 'Session' },
        { value: 'event', label: 'Event' },
      ],
    },
    {
      name: 'status',
      interface: 'select',
      enum: ['scheduled', 'confirmed', 'completed', 'cancelled', 'noShow'].map((value) => ({ value, label: value })),
    },
  ];
  let element = null;
  const ctx = {
    React,
    antd,
    dayjs,
    model: { parent: { subModels: { items: [{ use: 'JSBlockModel' }, table] } } },
    engine: { getModel: () => table },
    dataSourceManager: {
      getDataSource: () => ({ collectionManager: { getCollection: () => ({ getFields: () => fields }) } }),
    },
    router: {
      navigate(url, options) {
        navigations.push({ url, options });
        window.history.replaceState(null, '', url);
      },
    },
    api: {
      async request({ url, params = {} }) {
        calls.push({ url, params });
        const [resourceName, action] = url.split(':');
        if (resourceName === 'appointments' && action === 'list') {
          const filtered = data.filter((row) => matches(row, params.filter));
          return { data: { data: params.pageSize === 1 ? [] : filtered, meta: { count: filtered.length } } };
        }
        return { data: { data: [] } };
      },
    },
    render: (node) => {
      element = node;
    },
  };
  new Function('ctx', TOOLBAR_CODE)(ctx);
  const view = render(element);
  const appointmentCalls = () => calls.filter((call) => call.url === 'appointments:list');
  return { ctx, resource, calls, navigations, data, view, appointmentCalls };
}

// antd prefixes the focused tab's accessible name with "Tab 2 of 3" for screen readers, so match the label
// as a word rather than from the start of the name.
const tab = (name) => screen.getByRole('tab', { name: new RegExp('(^|\\s)' + name + '\\b') });
const settle = async (ms = 450) => {
  await act(async () => {
    await sleep(ms);
  });
};

test.afterEach(() => cleanup());

test('renders All / Sessions / Events as tabs with All selected and counts from the server', async () => {
  const { appointmentCalls } = mount();
  const tabs = screen.getAllByRole('tab');
  assert.deepEqual(
    tabs.map((node) => node.textContent.replace(/\d+$/, '')),
    ['All', 'Sessions', 'Events'],
  );
  assert.equal(tab('All').getAttribute('aria-selected'), 'true');
  assert.equal(tab('Events').getAttribute('aria-selected'), 'false');
  assert.equal(screen.getByRole('tablist') !== null, true);

  await waitFor(() => assert.equal(tab('All').textContent, 'All 5'), { timeout: 3000 });
  assert.equal(tab('Sessions').textContent, 'Sessions 3');
  assert.equal(tab('Events').textContent, 'Events 2');

  // three tab counts + five status counts, every one a one-row request; no appointment rows are fetched
  assert.equal(appointmentCalls().length, 8);
  assert.ok(
    appointmentCalls().every((call) => call.params.pageSize === 1),
    'rows were fetched just to be filtered',
  );
});

test('selecting a tab filters on the server using the T-40 category values, and only refreshes status counts', async () => {
  const { resource, appointmentCalls, navigations } = mount();
  await waitFor(() => assert.equal(tab('Events').textContent, 'Events 2'), { timeout: 3000 });
  const before = appointmentCalls().length;

  fireEvent.click(tab('Events'));
  await settle();

  assert.equal(tab('Events').getAttribute('aria-selected'), 'true');
  assert.equal(tab('All').getAttribute('aria-selected'), 'false');
  assert.equal(resource.refreshCalls, 1, 'the table is refreshed exactly once');
  assert.deepEqual(Object.values(resource.filterGroups), [{ $and: [getCategoryFilter('events')] }]);
  assert.equal(resource.page, 1);

  const after = appointmentCalls().slice(before);
  assert.equal(after.length, 5, 'only the five status counts are requested after a tab change');
  assert.ok(
    after.every((call) => JSON.stringify(call.params.filter).includes('"category"')),
    'counts must follow the tab',
  );
  assert.ok(after.every((call) => JSON.stringify(call.params.filter).includes('"status"')));
  assert.equal(tab('Events').textContent, 'Events 2', 'tab counts are not refetched on a tab change');
  assert.ok(screen.getByText('Events in view'));

  assert.deepEqual(navigations, [{ url: '/admin/7rbhpfmdhv5?tab=events', options: { replace: true } }]);
  assert.equal(window.location.search, '?tab=events');

  fireEvent.click(tab('All'));
  await settle();
  assert.deepEqual(resource.filterGroups, {}, 'All removes the category filter');
  assert.equal(window.location.search, '', 'the default tab leaves the URL clean');
});

test('tabs are keyboard operable: arrow keys move focus, Enter selects', async () => {
  const { resource } = mount();
  await waitFor(() => assert.equal(tab('All').textContent, 'All 5'), { timeout: 3000 });
  const all = tab('All');
  all.focus();
  assert.equal(all.getAttribute('tabindex'), '0');
  assert.equal(tab('Events').getAttribute('tabindex'), '-1');

  fireEvent.keyDown(all, { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, which: 39 });
  assert.equal(document.activeElement, tab('Sessions'), 'the arrow key moves focus without selecting');
  assert.equal(tab('All').getAttribute('aria-selected'), 'true');
  assert.deepEqual(resource.filterGroups, {});

  fireEvent.keyDown(tab('Sessions'), { key: 'Enter', code: 'Enter', keyCode: 13, which: 13 });
  await settle();

  assert.equal(tab('Sessions').getAttribute('aria-selected'), 'true');
  assert.deepEqual(Object.values(resource.filterGroups), [{ $and: [getCategoryFilter('sessions')] }]);

  // Space works the same way, and Enter on the already selected tab changes nothing
  fireEvent.keyDown(tab('Sessions'), { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, which: 39 });
  fireEvent.keyDown(tab('Events'), { key: ' ', code: 'Space', keyCode: 32, which: 32 });
  await settle();
  assert.equal(tab('Events').getAttribute('aria-selected'), 'true');
  assert.deepEqual(Object.values(resource.filterGroups), [{ $and: [getCategoryFilter('events')] }]);
  const refreshes = resource.refreshCalls;
  fireEvent.keyDown(tab('Events'), { key: 'Enter', code: 'Enter', keyCode: 13, which: 13 });
  await settle(100);
  assert.equal(resource.refreshCalls, refreshes, 'selecting the current tab again must not refetch');
});

test('tab counts follow the other filters; Clear keeps the selected tab', async () => {
  const { resource } = mount();
  await waitFor(() => assert.equal(tab('All').textContent, 'All 5'), { timeout: 3000 });
  fireEvent.click(tab('Events'));
  await settle();

  fireEvent.change(screen.getByPlaceholderText(/Search customer/), { target: { value: 'Emma' } });
  await settle(900);
  assert.equal(tab('All').textContent, 'All 1');
  assert.equal(tab('Sessions').textContent, 'Sessions 0');
  assert.equal(tab('Events').textContent, 'Events 1');
  assert.equal(JSON.stringify(Object.values(resource.filterGroups)[0]).includes('Emma'), true);

  fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
  await settle();
  assert.equal(tab('Events').getAttribute('aria-selected'), 'true', 'Clear must not change the tab');
  assert.deepEqual(Object.values(resource.filterGroups), [{ $and: [getCategoryFilter('events')] }]);
  assert.equal(tab('All').textContent, 'All 5');
});

test('shows a polite, useful empty state per tab and for filters that match nothing', async () => {
  const { data } = mount({ rows: ROWS.filter((row) => row.category === 'session') });
  await waitFor(() => assert.equal(tab('Sessions').textContent, 'Sessions 3'), { timeout: 3000 });
  const region = screen.getByRole('status');
  assert.equal(region.getAttribute('aria-live'), 'polite');
  assert.equal(region.textContent, '', 'no message while records exist');

  fireEvent.click(tab('Events'));
  await settle();
  assert.match(region.textContent, /No events yet\. Set an appointment.s category to Event/);

  fireEvent.click(tab('Sessions'));
  await settle();
  fireEvent.change(screen.getByPlaceholderText(/Search customer/), { target: { value: 'zzz' } });
  await settle(900);
  assert.match(region.textContent, /No sessions match these filters\./);
  fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
  await settle();
  assert.equal(region.textContent, '');
  assert.equal(data.length, 3);
});

test('a record created, edited or deleted elsewhere moves between tabs and updates the counts', async () => {
  const { resource, data, appointmentCalls } = mount();
  await waitFor(() => assert.equal(tab('All').textContent, 'All 5'), { timeout: 3000 });
  assert.equal(resource.listenerCount('refresh'), 1);

  // create: a new event appears under Events
  data.push({ id: 6, category: 'event', status: 'scheduled', customer: { firstName: 'Zoe' } });
  resource.emit('refresh');
  await waitFor(() => assert.equal(tab('Events').textContent, 'Events 3'), { timeout: 3000 });
  assert.equal(tab('All').textContent, 'All 6');

  // edit: a session changes category and moves tabs
  data.find((row) => row.id === 1).category = 'event';
  resource.emit('refresh');
  await waitFor(() => assert.equal(tab('Sessions').textContent, 'Sessions 2'), { timeout: 3000 });
  assert.equal(tab('Events').textContent, 'Events 4');
  assert.equal(tab('All').textContent, 'All 6');

  // delete: the record disappears from its tab and from All
  data.splice(
    data.findIndex((row) => row.id === 4),
    1,
  );
  resource.emit('refresh');
  await waitFor(() => assert.equal(tab('Events').textContent, 'Events 3'), { timeout: 3000 });
  assert.equal(tab('All').textContent, 'All 5');

  // bursts of refresh events (for example a bulk delete) are coalesced into one count refresh
  const before = appointmentCalls().length;
  resource.emit('refresh');
  resource.emit('refresh');
  resource.emit('refresh');
  await settle(600);
  assert.equal(appointmentCalls().length - before, 8);
});

test('pagination refreshes and the toolbar own refreshes do not trigger extra count requests', async () => {
  const { resource, appointmentCalls } = mount();
  await waitFor(() => assert.equal(tab('All').textContent, 'All 5'), { timeout: 3000 });
  const before = appointmentCalls().length;

  resource.page = 2;
  resource.emit('refresh');
  await settle(500);
  assert.equal(appointmentCalls().length, before, 'changing page must not refetch counts');

  fireEvent.click(tab('Sessions'));
  await settle(500);
  assert.equal(appointmentCalls().length - before, 5, 'a tab change costs the five status counts once, not twice');
});

test('a deep link opens the requested tab and filters the table once the table is ready', async () => {
  const { resource, appointmentCalls } = mount({ search: '?tab=events' });
  assert.equal(tab('Events').getAttribute('aria-selected'), 'true');
  await waitFor(() => assert.equal(resource.refreshCalls, 1), { timeout: 3000 });
  assert.deepEqual(Object.values(resource.filterGroups), [{ $and: [getCategoryFilter('events')] }]);
  await waitFor(() => assert.equal(tab('Events').textContent, 'Events 2'), { timeout: 3000 });
  assert.equal(appointmentCalls().length, 8, 'initial counts are requested once, not twice');
});

test('an unknown tab in the URL falls back to All', async () => {
  const { resource } = mount({ search: '?tab=bogus' });
  assert.equal(tab('All').getAttribute('aria-selected'), 'true');
  await settle(300);
  assert.equal(resource.refreshCalls, 0);
  assert.deepEqual(resource.filterGroups, {});
});

test('the toolbar removes its refresh listener when it unmounts', async () => {
  const { resource, view } = mount();
  await waitFor(() => assert.equal(resource.listenerCount('refresh'), 1), { timeout: 3000 });
  view.unmount();
  assert.equal(resource.listenerCount('refresh'), 0);
});
