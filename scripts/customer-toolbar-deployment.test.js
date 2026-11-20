const test = require('node:test');
const assert = require('node:assert/strict');
require('./test-support/jsdom-env').installDom();
const React = require('react');
const ReactDOM = require('react-dom/client');
const { render, screen, waitFor, cleanup, act } = require('@testing-library/react');
const { reactOwnedColumnsContainer } = require('./apply-customer-birthday-window');
test.afterEach(cleanup);

test('React-owned Columns container stays in the table action bar and unmounts safely', async () => {
  const legacy = `function Widget() {
  const columnsMenu = h('button', null, 'Columns');
  const canColRoot = true;
  const colSlot = useRef(null);
  const colRoot = useRef(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!canColRoot) return undefined;
    const placeCols = () => {
      const t = getTable();
      if (!t) return;
      if (!colSlot.current) { colSlot.current = document.createElement('div'); colSlot.current.className = 'bw-cols-slot'; colSlot.current.style.display = 'inline-flex'; }
      const card = document.querySelector('[data-uid="' + t.uid + '"]');
      const right = card.querySelector('.ant-space');
      if (right && colSlot.current.parentElement !== right) right.insertBefore(colSlot.current, right.firstChild);
      if (!colRoot.current && colSlot.current.isConnected) { colRoot.current = ctx.libs.ReactDOM.createRoot(colSlot.current); setTick((x) => x + 1); }
    };
    placeCols();
    const timer = setInterval(placeCols, 800);
    return () => { clearInterval(timer); const r = colRoot.current; colRoot.current = null; setTimeout(() => r && r.unmount(), 0); if (colSlot.current) colSlot.current.remove(); };
  }, []);
  useEffect(() => { if (colRoot.current) colRoot.current.render(columnsMenu); });
  return h('div', { 'data-customer-toolbar': 'true' },
    // BW-TABLE-PREFS: keep page info and rows-per-page visible on phones
    h('span', null, 'Toolbar'));
}`;
  const code = reactOwnedColumnsContainer(legacy);
  assert.equal(code.includes('document.createElement'), false);
  const Widget = new Function('React', 'ctx', 'getTable', `const { useRef, useState, useEffect } = React; const h = React.createElement; ${code}; return Widget;`)(
    React, { libs: { ReactDOM } }, () => ({ uid: 'customer-table' }),
  );
  const h = React.createElement;
  const view = render(h(React.Fragment, null,
    h('div', { 'data-uid': 'customer-table' }, h('div', { className: 'ant-space' }, h('button', null, 'Refresh'))),
    h(Widget)));
  await waitFor(() => assert.ok(screen.getByRole('button', { name: 'Columns' })));
  assert.equal(screen.getByRole('button', { name: 'Columns' }).parentElement.parentElement.className, 'ant-space');
  assert.equal(document.querySelector('.ant-space').firstElementChild.className, 'bw-cols-slot');
  view.unmount();
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  assert.equal(document.querySelector('.bw-cols-slot'), null);
});
