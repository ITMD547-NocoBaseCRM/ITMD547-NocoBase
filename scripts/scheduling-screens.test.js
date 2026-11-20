const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { installDom } = require('./test-support/jsdom-env');
installDom();
const React = require('react');
const antd = require('antd');
const { render, screen, waitFor, cleanup, fireEvent, act } = require('@testing-library/react');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
test.afterEach(cleanup);

async function mount(file, ctx) {
  let element;
  await new AsyncFunction('ctx', fs.readFileSync(file, 'utf8'))({ libs: { React, antd }, ...ctx, render: (node) => { element = node; } });
  const view = render(element);
  return Object.assign(view, { refresh: () => view.rerender(React.cloneElement(element)) });
}

test('new booking quietly displays an empty staff result and permits unassigned booking', async () => {
  const requests = [];
  const cleared = [];
  await mount('scripts/ui/appointment-available-staff.js', {
    formValues: { startTime: '2026-10-22T14:07:00Z', endTime: '2026-10-22T15:07:00Z' },
    getValue: () => ({ id: 1 }), setValue: (value) => cleared.push(value),
    api: { request: async (request) => { requests.push(request); return { data: { data: { staff: [] } } }; } },
  });
  await waitFor(() => assert.ok(screen.getByText('No staff available. You can continue and book this appointment without assigning staff.')));
  assert.deepEqual(cleared, [null]);
  assert.ok(requests.every((request) => request.url === 'appointmentAvailability:availableStaff'));
  assert.equal(document.querySelectorAll('.ant-notification-notice').length, 0);
});

test('details assignment uses one silent batch check and excludes the current appointment', async () => {
  const requests = [];
  await mount('scripts/ui/appointment-details-staff.js', {
    getVar: async () => ({ id: 20, startTime: '2026-10-22T14:07:00Z', endTime: '2026-10-22T15:07:00Z' }),
    api: { request: async (request) => { requests.push(request); return { data: { data: { staff: [] } } }; } },
  });
  await waitFor(() => assert.ok(screen.getByText('No staff are on shift and free for this time.')));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'appointmentAvailability:availableStaff');
  assert.equal(requests[0].data.excludeAppointmentId, 20);
  assert.equal(document.querySelectorAll('.ant-notification-notice').length, 0);
});

test('opening an assigned appointment keeps its technician and never runs per-staff validation or saves', async () => {
  const requests = [];
  const staff = { id: 2, firstName: 'Prady', lastName: 'vp' };
  await mount('scripts/ui/appointment-details-staff.js', {
    getVar: async () => ({ id: 20, staffId: 2, staff, startTime: '2026-11-10T18:00:00Z', endTime: '2026-11-10T20:15:00Z' }),
    makeResource: () => { throw new Error('Opening Details must not create a write resource'); },
    api: { request: async (request) => {
      requests.push(request);
      assert.equal(request.url, 'appointmentAvailability:availableStaff');
      assert.equal(request.data.excludeAppointmentId, 20);
      return { data: { data: { staff: [staff] } } };
    } },
  });
  await waitFor(() => assert.ok(screen.getByText('Prady vp')));
  assert.equal(requests.length, 1);
  assert.equal(screen.queryByRole('alert'), null);
  assert.equal(document.querySelectorAll('.ant-notification-notice').length, 0);
});

test('an assigned technician absent from availability stays visible without a global error', async () => {
  const requests = [];
  await mount('scripts/ui/appointment-details-staff.js', {
    getVar: async () => ({ id: 20, staffId: 2, staff: { id: 2, firstName: 'Prady', lastName: 'vp' }, startTime: '2026-11-10T18:00:00Z', endTime: '2026-11-10T20:15:00Z' }),
    makeResource: () => { throw new Error('Opening Details must not change the assignment'); },
    api: { request: async (request) => { requests.push(request); return { data: { data: { staff: [] } } }; } },
  });
  await waitFor(() => assert.ok(screen.getByText('Prady vp (currently assigned, unavailable)')));
  assert.equal(requests.length, 1);
  assert.equal(screen.queryByRole('alert'), null);
  assert.equal(document.querySelectorAll('.ant-notification-notice').length, 0);
});

test('dashboard includes in-progress bookings and totals only appointments completed today', async () => {
  const requests = [];
  const statuses = ['scheduled', 'confirmed', 'inProgress', 'completed', 'cancelled', 'noShow'];
  const today = new Date();
  const startTime = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 10).toISOString();
  const rows = statuses.map((status, i) => ({ id: i + 1, status, startTime, endTime: new Date(new Date(startTime).getTime() + 3600000).toISOString(), customer: { firstName: 'Client' + i }, appointmentServices: [{ priceAtBooking: (i + 1) * 10, service: { name: 'Service' } }] }));
  const olderCompleted = { id: 7, status: 'completed', startTime: '2026-10-01T14:00:00Z', appointmentServices: [{ priceAtBooking: 80 }] };
  const view = await mount('scripts/ui/salon-dashboard.js', {
    makeResource: () => {
      let filter;
      return { setResourceName() {}, setPageSize() {}, setFilter(value) { filter = value; }, setSort() {}, setFields() {}, refresh: async () => {}, getData: () => [olderCompleted, ...rows].filter((item) => item.startTime >= filter.$and[0].startTime.$gte && item.startTime < filter.$and[1].startTime.$lt) };
    },
    api: { request: async (request) => { requests.push(request); return { data: { data: { staff: [] } } }; } },
  });
  await waitFor(() => assert.ok(screen.getByText('Today’s schedule (4)')));
  const current = screen.getByText('Current earnings').closest('.ant-card-body');
  const expected = screen.getByText('Expected earnings').closest('.ant-card-body');
  assert.ok(current.textContent.includes('$40.00'));
  assert.ok(current.textContent.includes('completed today'));
  assert.ok(expected.textContent.includes('$100.00'));
  assert.ok(screen.getByText('Client2'), 'in-progress client is visible');
  fireEvent.click(screen.getAllByRole('button', { name: /Assign staff/ })[0]);
  await waitFor(() => assert.equal(requests.length, 1));
  assert.equal(requests[0].url, 'appointmentAvailability:availableStaff');
  assert.ok(view.container.querySelector('[style*="grid-template-columns"]'));
});

test('an earlier staff response cannot overwrite a changed appointment slot', async () => {
  const pending = [];
  const values = { startTime: '2026-10-22T14:07:00Z', endTime: '2026-10-22T15:07:00Z' };
  const view = await mount('scripts/ui/appointment-available-staff.js', {
    formValues: values, getValue: () => null,
    api: { request: (request) => new Promise((resolve) => pending.push({ request, resolve })) },
  });
  await waitFor(() => assert.equal(pending.length, 1));
  values.startTime = '2026-10-22T16:07:00Z'; values.endTime = '2026-10-22T17:07:00Z';
  view.refresh();
  await act(async () => { pending[0].resolve({ data: { data: { staff: [{ id: 1, firstName: 'Earlier', lastName: 'Staff' }] } } }); });
  assert.equal(screen.queryByText('1 staff available'), null);
  await waitFor(() => assert.equal(pending.length, 2));
  assert.equal(new Date(pending[1].request.data.startTime).getTime(), new Date(values.startTime).getTime());
  await act(async () => { pending[1].resolve({ data: { data: { staff: [{ id: 2, firstName: 'Current', lastName: 'Staff' }] } } }); });
  await waitFor(() => assert.ok(screen.getByText('1 staff available')));
  fireEvent.mouseDown(screen.getByRole('combobox'));
  await waitFor(() => assert.ok(screen.getByText('Current Staff')));
  assert.equal(screen.queryByText('Earlier Staff'), null);
});
