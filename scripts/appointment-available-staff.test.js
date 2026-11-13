const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { installDom } = require('./test-support/jsdom-env');

installDom({ url: 'http://localhost/' });
const React = require('react');
const { cleanup, render, waitFor } = require('@testing-library/react');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

const messages = [
  'This time is outside the staff member’s available schedule.',
  'The selected staff member does not provide every selected service.',
  'This staff member already has an appointment at that time.',
];
const responseError = (status, ...texts) => ({ response: { status, data: { errors: texts.map((message) => ({ message })) } } });
const rows = Array.from({ length: 6 }, (_, index) => ({ id: index + 1, firstName: `Staff ${index + 1}`, active: 'active' }));
const failures = new Map([
  [2, responseError(409, messages[0])],
  [3, responseError(409, messages[1])],
  [4, responseError(409, messages[2])],
  [5, responseError(409, 'This time overlaps staff leave.')],
  [6, responseError(503, 'Availability is temporarily unavailable.')],
]);

for (const script of ['appointment-available-staff.js', 'appointment-details-staff.js']) {
  test(`${script} suppresses only expected background-check notifications`, async () => {
    const calls = [];
    const notifications = [];
    let view;
    const Select = (props) => React.createElement('div', { 'data-testid': 'staff-options' }, JSON.stringify(props.options));
    const Alert = (props) => React.createElement('div', { 'data-testid': 'staff-status' }, props.message);
    const ctx = {
      libs: { React, antd: { Select, Alert, Spin: () => null, message: { success() {} } } },
      formValues: { startTime: '2026-11-13T15:00:00Z', endTime: '2026-11-13T16:00:00Z', selectedServices: [{ id: 7 }] },
      getVar: async () => ({ id: 123, startTime: '2026-11-13T15:00:00Z', endTime: '2026-11-13T16:00:00Z' }),
      getValue: () => null,
      makeResource: () => ({ setResourceName() {}, setPageSize() {}, setFilter() {}, setFields() {}, refresh: async () => {}, getData: () => rows }),
      api: { request: async (config) => {
        calls.push(config);
        const error = failures.get(config.data.staffId);
        if (!error) return {};
        if (!config.skipNotify(error)) notifications.push(error);
        throw error;
      } },
      render: (element) => { view = render(element); },
    };
    try {
      await new AsyncFunction('ctx', fs.readFileSync(`${__dirname}/ui/${script}`, 'utf8'))(ctx);
      await waitFor(() => {
        const options = JSON.parse(view.getByTestId('staff-options').textContent);
        assert.deepEqual(options.map((option) => option.value), [1]);
      });
      assert.equal(calls.length >= rows.length, true);
      assert.deepEqual([...new Set(notifications.map((error) => error.response.status))].sort(), [409, 503]);
      const request = calls[0];
      for (const text of messages) assert.equal(request.skipNotify(responseError(409, text)), true);
      assert.equal(request.skipNotify(responseError(409, messages[0], 'Unexpected conflict')), false);
      assert.equal(request.skipNotify(responseError(503, messages[0])), false);
      assert.equal(request.skipNotify(responseError(409)), false);
      assert.equal(request.skipNotify({}), false);
      if (script === 'appointment-available-staff.js') {
        assert.equal(view.getByTestId('staff-status').textContent, '1 staff available');
        assert.deepEqual(request.data.serviceIds, [7]);
      }
      assert.equal(request.data.excludeAppointmentId, 123);
    } finally {
      cleanup();
    }
  });
}