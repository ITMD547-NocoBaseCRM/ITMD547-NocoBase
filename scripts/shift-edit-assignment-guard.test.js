const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'ui/shift-edit-assignment-guard.js'), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const run = new AsyncFunction('ctx', 'window', source);

function fixture({ status = 'onLeave', choose = null, appointments = [], modal = true } = {}) {
  const writes = [];
  const notices = [];
  let opened = false;
  const shift = {
    id: 5,
    staffId: 10,
    status: 'scheduled',
    startTime: '2026-10-23T14:00:00.000Z',
    endTime: '2026-10-23T22:00:00.000Z',
  };
  const ctx = {
    form: { getFieldsValue: () => ({ id: 5, status, startTime: shift.startTime, endTime: shift.endTime }) },
    view: { inputArgs: { filterByTk: 5 } },
    getVar: async () => 5,
    makeResource: () => {
      let name;
      let id;
      return {
        setResourceName: (value) => { name = value; },
        setFilterByTk: (value) => { id = value; },
        refresh: async () => {},
        getData: () => shift,
        save: async (value) => { writes.push({ name, id, value }); },
      };
    },
    request: async () => ({ data: { data: { appointments } } }),
    React: { createElement: (type, props, ...children) => ({ type, props: props || {}, children }) },
    antd: {
      Modal: { confirm: ({ content, onOk, onCancel }) => {
        opened = true;
        if (choose) {
          const visit = (node) => {
            if (!node || typeof node !== 'object') return;
            if (node.type === 'Select' && node.props.onChange) node.props.onChange(choose);
            for (const child of node.children || []) visit(child);
          };
          visit(content);
        }
        return modal ? onOk() : onCancel();
      } },
      Select: 'Select', Alert: 'Alert', Typography: { Text: 'Text' },
    },
    message: { error: (text) => notices.push(text) },
    exitAll: () => { throw new Error('FLOW_EXIT'); },
  };
  return { ctx, writes, notices, get opened() { return opened; } };
}

const booking = {
  id: 80,
  customerName: 'Alex',
  startTime: '2026-10-23T15:00:00.000Z',
  endTime: '2026-10-23T16:00:00.000Z',
  candidates: [{ id: 20, name: 'Taylor' }],
};

test('no affected appointments: native submit continues without a popup', async () => {
  const f = fixture();
  await run(f.ctx, { location: { origin: 'http://localhost:13000' } });
  assert.equal(f.opened, false);
  assert.deepEqual(f.writes, []);
});

test('assign later clears the staff before the native shift save', async () => {
  const f = fixture({ appointments: [booking] });
  await run(f.ctx, { location: { origin: 'http://localhost:13000' } });
  assert.equal(f.opened, true);
  assert.deepEqual(f.writes, [{ name: 'appointments', id: 80, value: { staffId: null } }]);
});

test('reassignment uses selected available staff', async () => {
  const f = fixture({ appointments: [booking], choose: 20 });
  await run(f.ctx, { location: { origin: 'http://localhost:13000' } });
  assert.deepEqual(f.writes, [{ name: 'appointments', id: 80, value: { staffId: 20 } }]);
});

test('cancel leaves appointments untouched and prevents shift save', async () => {
  const f = fixture({ appointments: [booking], modal: false });
  await assert.rejects(run(f.ctx, { location: { origin: 'http://localhost:13000' } }), /FLOW_EXIT/);
  assert.deepEqual(f.writes, []);
});
