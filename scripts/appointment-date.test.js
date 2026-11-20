const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { splitLayout, legacyOf, startTimeCode, hasSplitRow } = require('./apply-appointment-date');

const ids = { date: 'D', start: 'S', end: 'E' };

test('moves date, start and end into one row where start was', () => {
  const layout = { version: 2, rows: [
    { id: 'r1', cells: [{ id: 'c', items: ['customer'] }], sizes: [24] },
    { id: 'r2', cells: [{ id: 'a', items: ['D'] }, { id: 'b', items: ['S', 'E', 'services', 'staff'] }], sizes: [12, 12] },
    { id: 'r3', cells: [{ id: 'n', items: ['notes'] }], sizes: [24] },
  ] };
  const out = splitLayout(layout, ids);
  assert.deepEqual(out.rows.map((r) => r.cells.map((c) => c.items)), [[['customer']], [['D'], ['S'], ['E']], [['services', 'staff']], [['notes']]]);
  assert.deepEqual(out.rows[1].sizes, [8, 8, 8]);
  assert.deepEqual(out.rows[2].sizes, [24]);
  assert.ok(hasSplitRow(out, ids));
  assert.equal(layout.rows[1].cells[0].items[0], 'D', 'input not mutated');
});

test('is idempotent', () => {
  const once = splitLayout({ rows: [{ id: 'r', cells: [{ id: 'x', items: ['S', 'D', 'E', 'z'] }], sizes: [24] }] }, ids);
  assert.deepEqual(splitLayout(once, ids).rows, once.rows);
});

test('date added at the end of the form still lands next to start time', () => {
  const out = splitLayout({ rows: [
    { id: 'r1', cells: [{ id: 'a', items: ['S'] }, { id: 'b', items: ['E'] }], sizes: [12, 12] },
    { id: 'r2', cells: [{ id: 'c', items: ['notes'] }], sizes: [24] },
    { id: 'r3', cells: [{ id: 'd', items: ['D'] }], sizes: [24] },
  ] }, ids);
  assert.deepEqual(out.rows.map((r) => r.id), ['rowWhen', 'r2']);
});

test('legacy shape mirrors the layout', () => {
  const out = splitLayout({ rows: [{ id: 'r', cells: [{ id: 'x', items: ['S', 'D', 'E'] }], sizes: [24] }] }, ids);
  assert.deepEqual(legacyOf(out), { rows: { rowWhen: [['D'], ['S'], ['E']] }, sizes: { rowWhen: [8, 8, 8] }, rowOrder: ['rowWhen'] });
});

test('start time script variants', () => {
  const src = fs.readFileSync(path.join(__dirname, 'ui', 'appointment-start-time.js'), 'utf8');
  assert.match(startTimeCode(src, true), /\/\*SEPARATE_DATE\*\/true/);
  assert.match(startTimeCode(src, false), /\/\*SEPARATE_DATE\*\/false/);
  assert.throws(() => startTimeCode('no switch', true));
});

test('date field makes no API requests (RunJS validator)', () => {
  const src = fs.readFileSync(path.join(__dirname, 'ui', 'appointment-date.js'), 'utf8');
  assert.doesNotMatch(src, /ctx\.api\.request/);
  assert.match(src, /BW-APPT-DATE/);
});

test('handles rows nested inside cells (the live form layouts)', () => {
  const layout = { version: 2, rows: [
    { id: 'row1', cells: [{ id: 'c0', rows: [{ id: 'in1', cells: [{ id: 'a', items: ['customer'] }], sizes: [24] }, { id: 'in2', cells: [{ id: 'b', items: ['S'] }, { id: 'c', items: ['E'] }], sizes: [12, 12] }] }], sizes: [24] },
    { id: 'row2', cells: [{ id: 'd', items: ['D'] }], sizes: [24] },
  ] };
  const out = splitLayout(layout, ids);
  assert.ok(hasSplitRow(out, ids));
  assert.deepEqual(out.rows.map((r) => r.id), ['row1']);
  assert.deepEqual(out.rows[0].cells[0].rows.map((r) => r.id), ['in1', 'rowWhen']);
  assert.deepEqual(legacyOf(out).rows.row1, [['customer', 'D', 'S', 'E']]);
  assert.equal(splitLayout(out, ids), out, 'already split → unchanged');
});
