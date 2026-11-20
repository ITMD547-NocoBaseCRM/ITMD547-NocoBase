// Staff financial restrictions – page blocks (display only; the data is refused on the server by the CRM plugin's
// financial guard and the role permissions, see docs/rbac.md → "Financial data").
//
// Patches two existing JS blocks in place, without changing what Admin and Manager see:
//  - Statistics → Staff Performance (BW-STATS block, BW_VIEW = 'staff'): roles without financial access do not
//    request payments and see nonfinancial cards (completed, completion rate, cancelled/no-show, most booked service)
//    instead of revenue cards, and no "Revenue per technician" section.
//  - Dashboard ("Today at a glance"): the Expected / Current earnings cards and the per-appointment amounts are shown
//    only to roles with financial access, and the price fields are requested only for them.
// The server answers `crmAccess:get` → { financial } for the signed-in role.
//
// Environment-neutral like rbac-core: `request(action, { method, body })` resolves to { ok, status, json }.

const MARK = '/* BW-FIN v1 */';

function replaceOnce(code, fromLf, toLf, what) {
  // Some blocks were saved with Windows line endings: match and write in the block's own style.
  const nl = code.includes('\r\n') ? '\r\n' : '\n';
  const from = fromLf.split('\n').join(nl);
  const to = toLf.split('\n').join(nl);
  const at = code.indexOf(from);
  if (at < 0) throw new Error(`staff-financial-ui: ${what}: anchor not found (block changed?)`);
  if (code.indexOf(from, at + from.length) >= 0) throw new Error(`staff-financial-ui: ${what}: anchor is not unique`);
  return code.slice(0, at) + to + code.slice(at + from.length);
}

const FINANCE_HELPER = `${MARK}
// Financial widgets only for roles the server allows to see financial data (crmAccess:get). Display only: the data
// itself is refused on the server for other roles.
const bwFinance = () => {
  if (!window.__bwFinancePromise) {
    window.__bwFinancePromise = ctx.api.request({ url: 'crmAccess:get', skipNotify: true })
      .then((r) => !!(r && r.data && r.data.data && r.data.data.financial), () => false);
  }
  return window.__bwFinancePromise;
};
`;

const STAFF_FOOTNOTE = "'Each appointment has one technician, so its services and payments are credited to that technician; nothing is split. Appointments count by appointment date; revenue by payment date, using the Earnings rules (paid payments minus refunds; pending, failed and refunded payments excluded). Average per completed appointment = revenue ÷ completed appointments in the same range. Skill demand counts each booked service once. Office staff (receptionist, admin, manager) appear only when they have appointments.'";

function patchStaffPerformance(code) {
  if (code.includes(MARK)) return code;
  if (!code.includes("const BW_VIEW = 'staff';")) throw new Error('staff-financial-ui: not the Staff Performance block');
  let c = code;
  c = replaceOnce(c, '// ---------- staff performance: data loading', FINANCE_HELPER + '// ---------- staff performance: data loading', 'helper');
  c = replaceOnce(c, '  const promise = Promise.all([\n    q(\'appointments:query\'', '  const promise = bwFinance().then((finance) => Promise.all([\n    q(\'appointments:query\'', 'finance gate');
  c = c.split("    q('payments:query', { measures: money,").join("    !finance ? Promise.resolve([]) : q('payments:query', { measures: money,");
  c = replaceOnce(c, ']).then(([appts, pays, noAppt, lines]) => ({ appts, pays: pays.map(bwHourRow), noAppt: noAppt.map(bwHourRow), lines }));',
    ']).then(([appts, pays, noAppt, lines]) => ({ appts, pays: pays.map(bwHourRow), noAppt: noAppt.map(bwHourRow), lines, finance })));', 'result');
  c = replaceOnce(c, "    body = h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 } }, cards, appointments, revenue, skills);",
    `    // Nonfinancial view (Staff): counts only, no revenue cards or revenue section.
    const fin = d.finance !== false;
    const closed = rows.reduce((a, r) => a + r.c.completed + r.c.cancelled + r.c.noShow, 0);
    const lost = rows.reduce((a, r) => a + r.c.cancelled + r.c.noShow, 0);
    const plainCards = fin ? null : h('div', { style: { display: 'grid', gridTemplateColumns: cols, gap: narrow ? 8 : 12 } },
      h(Metric, { strong: true, compact: oneCol, style: narrow && !oneCol ? { gridColumn: '1 / -1' } : null, label: sel ? sel.name + ' · completed' : 'Completed appointments', value: String(completedTotal), sub: apptTotal + ' appointment' + (apptTotal === 1 ? '' : 's') + ' in the range' }),
      h(Metric, { compact: oneCol, label: 'Completion rate', value: closed ? Math.round((completedTotal / closed) * 100) + '%' : '—', sub: 'Completed ÷ completed, cancelled and no-show' }),
      h(Metric, { compact: oneCol, label: 'Cancelled / no-show', value: String(lost), sub: 'In the selected range' }),
      h(Metric, { compact: oneCol, label: 'Most booked service', value: demand.services[0] ? demand.services[0].name : 'No bookings', sub: demand.services[0] ? demand.services[0].n + ' bookings' : '' }));
    body = h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 } }, fin ? cards : plainCards, appointments, fin ? revenue : null, skills);`, 'body');
  c = replaceOnce(c, STAFF_FOOTNOTE,
    `(d && d.finance === false ? 'Each appointment has one technician. Appointments count by appointment date. Completion rate counts appointments that have finished (completed, cancelled or no-show). Skill demand counts each booked service once.' : ${STAFF_FOOTNOTE})`, 'footnote');
  return c;
}

function patchDashboard(code) {
  if (code.includes(MARK)) return code;
  if (!code.includes("label: 'Expected earnings'")) throw new Error('staff-financial-ui: not the Dashboard block');
  let c = code;
  c = replaceOnce(c, 'const loadAppointments = async (filter) => {', `${MARK}
const loadFinance = () => ctx.api.request({ url: 'crmAccess:get', skipNotify: true })
  .then((r) => !!(r && r.data && r.data.data && r.data.data.financial), () => false);
const PRICE_FIELDS = ['appointmentServices.priceAtBooking', 'appointmentServices.service.price'];
const loadAppointments = async (filter, finance) => {`, 'loader');
  c = replaceOnce(c, "    'appointmentServices.priceAtBooking', 'appointmentServices.service.name', 'appointmentServices.service.price',\n  ]);",
    "    'appointmentServices.service.name',\n    ...(finance ? PRICE_FIELDS : []),\n  ]);", 'fields');
  c = replaceOnce(c, "  const [state, setState] = useState({ loading: true, rows: [], error: '' });",
    "  const [state, setState] = useState({ loading: true, rows: [], error: '' });\n  const [finance, setFinance] = useState(false);", 'state');
  c = replaceOnce(c, '      const rows = await loadAppointments({ $and: [{ startTime: { $gte: start.toISOString() } }, { startTime: { $lt: end.toISOString() } }] });\n      setState({ loading: false, rows, error: \'\' });',
    "      const fin = await loadFinance();\n      const rows = await loadAppointments({ $and: [{ startTime: { $gte: start.toISOString() } }, { startTime: { $lt: end.toISOString() } }] }, fin);\n      setFinance(fin);\n      setState({ loading: false, rows, error: '' });", 'load');
  c = replaceOnce(c, 'function AppointmentCard({ item, onAssign, mobile }) {', 'function AppointmentCard({ item, onAssign, mobile, finance }) {', 'card props');
  c = replaceOnce(c, "        mobile ? h('span', { style: { flex: '0 0 auto', fontWeight: 650, fontSize: 12 } }, money.format(earning(item))) : null),",
    "        mobile && finance ? h('span', { style: { flex: '0 0 auto', fontWeight: 650, fontSize: 12 } }, money.format(earning(item))) : null),", 'card price (mobile)');
  c = replaceOnce(c, "      h('div', { style: { marginTop: 7, fontWeight: 650 } }, money.format(earning(item)))));",
    "      finance ? h('div', { style: { marginTop: 7, fontWeight: 650 } }, money.format(earning(item))) : null));", 'card price');
  c = replaceOnce(c, 'h(AppointmentCard, { key: item.id, item, onAssign: openAssignment, mobile })', 'h(AppointmentCard, { key: item.id, item, onAssign: openAssignment, mobile, finance })', 'card use');
  c = replaceOnce(c, "      h(Metric, { mobile, label: 'Expected earnings',", "      !finance ? null : h(Metric, { mobile, label: 'Expected earnings',", 'expected');
  c = replaceOnce(c, "      h(Metric, { mobile, label: 'Current earnings',", "      !finance ? null : h(Metric, { mobile, label: 'Current earnings',", 'current');
  return c;
}

async function applyStaffFinancialUi(request, { workspaceCode, check = false, log = () => {} } = {}) {
  const call = async (action, opts) => {
    const r = await request(action, opts);
    if (!r.ok) throw new Error(`${action.split('?')[0]} failed (${r.status}): ${JSON.stringify(r.json && (r.json.errors || r.json)).slice(0, 300)}`);
    return r.json && r.json.data;
  };
  const changes = [];
  const note = (m) => { changes.push(m); log(m); };
  const codeOf = (m) => String((m && m.stepParams && m.stepParams.jsSettings && m.stepParams.jsSettings.runJs && m.stepParams.jsSettings.runJs.code) || '');
  const setCode = async (model, code) => {
    const stepParams = { ...model.stepParams, jsSettings: { ...((model.stepParams || {}).jsSettings || {}), runJs: { ...(((model.stepParams || {}).jsSettings || {}).runJs || {}), version: 'v2', code } } };
    await call(`flowModels:update?filterByTk=${model.uid}`, { method: 'POST', body: { stepParams } });
  };
  const q = (v) => encodeURIComponent(JSON.stringify(v));
  const models = (await call(`flowModels:list?paginate=false&filter=${q({ use: 'JSBlockModel' })}`)) || [];
  const full = async (m) => (m.stepParams ? m : call(`flowModels:findOne?uid=${m.uid}`));
  let staffBlocks = 0;
  let dashboards = 0;
  for (const m0 of models) {
    const m = await full(m0);
    const code = codeOf(m);
    let next = null;
    if (code.includes('BW-STATS') && code.includes("const BW_VIEW = 'staff';")) { next = patchStaffPerformance(code); staffBlocks += 1; }
    else if (code.includes("label: 'Expected earnings'")) { next = patchDashboard(code); dashboards += 1; }
    else if (workspaceCode && code.startsWith(workspaceCode.split('\n')[0]) && code !== workspaceCode) next = workspaceCode;
    if (next && next !== code) {
      note(`block ${m.uid}: ${code.includes('BW-STATS') ? 'Staff Performance – nonfinancial view for Staff' : code.includes('Expected earnings') ? 'Dashboard – earnings cards for financial roles only' : 'My Workspace – nonfinancial metrics'}`);
      if (!check) await setCode(m, next);
    }
  }
  if (!staffBlocks) throw new Error('Staff Performance block not found');
  if (!dashboards) throw new Error('Dashboard block not found');
  return changes;
}

module.exports = { patchStaffPerformance, patchDashboard, applyStaffFinancialUi, MARK };
