// BW-STAFF-WORKSPACE v1 – "My Workspace" for technicians (mobile-friendly).
//
// Runs in NocoBase's JS block runtime. Data comes from staffWorkspace:get (@parlour/plugin-crm), which resolves the
// employee from the signed-in user on the server, and customerReviewAdmin:scores, which returns only the caller's
// own review scores for Staff. Nothing here chooses which employee to show.

const { React } = ctx.libs;
const { Alert, Button, Empty, Spin, Tag, Typography } = ctx.libs.antd;
const { useCallback, useEffect, useState } = React;
const h = React.createElement;

const TZ = 'America/Chicago';
const time = (v) => (v ? new Date(v).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }) : '');
const day = (v) => (v ? new Date(v).toLocaleDateString('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric' }) : '');
const money = (n) => (n == null ? '—' : `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const STATUS_COLOR = { scheduled: 'blue', confirmed: 'cyan', inProgress: 'purple', completed: 'green', cancelled: 'default', noShow: 'red', onLeave: 'orange' };
const label = (s) => String(s || '').replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
const errText = (e) => e?.response?.data?.errors?.[0]?.message || e?.message || 'Could not load your workspace.';
const sensitivities = (c) => [].concat(c?.skinSensitivities || []).concat(c?.skinSensitivitiesOther ? [c.skinSensitivitiesOther] : []).filter(Boolean);

const css = `
.bw-ws{display:flex;flex-direction:column;gap:12px}
.bw-ws-grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr))}
.bw-ws-card{background:var(--colorBgContainer,#fff);border:1px solid var(--colorBorderSecondary,#f0f0f0);border-radius:10px;padding:14px;min-width:0}
.bw-ws-card h4{margin:0 0 10px;font-size:15px;font-weight:600}
.bw-ws-kpis{display:grid;gap:8px;grid-template-columns:repeat(auto-fit,minmax(min(100%,130px),1fr))}
.bw-ws-kpi{border-radius:8px;padding:10px;background:var(--colorFillQuaternary,#fafafa)}
.bw-ws-kpi .v{font-size:20px;font-weight:600;line-height:1.2}
.bw-ws-kpi .l{font-size:12px;opacity:.7}
.bw-ws-row{display:flex;gap:10px;padding:8px 0;border-top:1px solid var(--colorBorderSecondary,#f0f0f0);align-items:flex-start}
.bw-ws-row:first-of-type{border-top:0}
.bw-ws-when{min-width:74px;font-weight:600;font-size:13px}
.bw-ws-main{flex:1;min-width:0;overflow-wrap:anywhere}
.bw-ws-sub{font-size:12px;opacity:.7}
.bw-ws-head{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:8px}
`;

function Section({ title, children, count }) {
  return h('div', { className: 'bw-ws-card' }, h('h4', null, title, count != null ? h(Typography.Text, { type: 'secondary', style: { fontWeight: 400, marginLeft: 6 } }, `(${count})`) : null), children);
}

function Appointment({ a, showDay }) {
  const warn = sensitivities(a.customer);
  return h(
    'div',
    { className: 'bw-ws-row' },
    h('div', { className: 'bw-ws-when' }, showDay ? h('div', null, day(a.startTime)) : null, time(a.startTime)),
    h(
      'div',
      { className: 'bw-ws-main' },
      h('div', null, a.customer ? `${a.customer.firstName || ''} ${a.customer.lastName || ''}`.trim() : 'Customer', ' ', h(Tag, { color: STATUS_COLOR[a.status] || 'default', style: { marginLeft: 4 } }, label(a.status))),
      h('div', { className: 'bw-ws-sub' }, a.services.join(', ') || 'No services listed', ' · until ', time(a.endTime)),
      warn.length ? h('div', { className: 'bw-ws-sub', style: { color: '#cf1322', opacity: 1 } }, '⚠ ', warn.join(', ')) : null,
    ),
  );
}

function Workspace() {
  const [state, setState] = useState({ loading: true, data: null, scores: null, error: null });

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const res = await ctx.api.request({ url: 'staffWorkspace:get', method: 'get', skipNotify: true });
      const now = new Date();
      const from = new Date(now.getTime() - 365 * 86400000).toISOString().slice(0, 10);
      const to = now.toISOString().slice(0, 10);
      let scores = null;
      try {
        const s = await ctx.api.request({ url: 'customerReviewAdmin:scores', method: 'post', data: { from, to }, skipNotify: true });
        scores = s?.data?.data || null;
      } catch (_) {
        scores = null;
      }
      setState({ loading: false, data: res?.data?.data || null, scores, error: null });
    } catch (e) {
      setState({ loading: false, data: null, scores: null, error: errText(e) });
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  if (state.loading && !state.data) return h('div', { style: { padding: 24, textAlign: 'center' } }, h(Spin));
  if (state.error) return h(Alert, { type: 'warning', showIcon: true, message: state.error, action: h(Button, { size: 'small', onClick: load }, 'Retry') });
  const d = state.data;
  const m = d.metrics;
  const myScore = (() => {
    const sc = state.scores;
    const rows = (sc && (sc.staff || sc.rows || sc.byStaff)) || [];
    const mine = Array.isArray(rows) ? rows.find((r) => String(r.staffId) === String(d.employee.id)) : null;
    if (mine) return { avg: mine.average ?? mine.avg ?? mine.averageRating, count: mine.count ?? mine.reviewCount };
    if (sc && (sc.average != null || sc.overall)) return { avg: sc.average ?? sc.overall?.average, count: sc.count ?? sc.overall?.count };
    return null;
  })();

  return h(
    'div',
    { className: 'bw-ws' },
    h('style', null, css),
    h(
      'div',
      { className: 'bw-ws-head' },
      h('div', null, h(Typography.Title, { level: 4, style: { margin: 0 } }, `Hi ${d.employee.name.split(' ')[0] || ''}`), h(Typography.Text, { type: 'secondary' }, new Date().toLocaleDateString('en-US', { timeZone: TZ, weekday: 'long', month: 'long', day: 'numeric' }))),
      h(Button, { onClick: load, loading: state.loading }, 'Refresh'),
    ),
    h(
      Section,
      { title: 'My performance · last 30 days' },
      h(
        'div',
        { className: 'bw-ws-kpis' },
        ...[
          [m.completed, 'Completed appointments'],
          [m.completionRate == null ? '—' : `${m.completionRate}%`, 'Completion rate'],
          [money(m.revenue), 'Revenue (paid)'],
          [myScore && myScore.avg != null ? `${Number(myScore.avg).toFixed(1)} ★` : '—', `Review average${myScore && myScore.count != null ? ` · ${myScore.count} reviews` : ''}`],
          [`${m.shiftsCompleted}/${m.shifts}`, 'Shifts completed'],
          [m.noShow + m.cancelled, 'Cancelled / no-show'],
        ].map(([v, l], i) => h('div', { key: i, className: 'bw-ws-kpi' }, h('div', { className: 'v' }, v), h('div', { className: 'l' }, l))),
      ),
    ),
    h(
      'div',
      { className: 'bw-ws-grid' },
      h(Section, { title: "Today's appointments", count: d.today.length }, d.today.length ? d.today.map((a) => h(Appointment, { key: a.id, a })) : h(Empty, { image: Empty.PRESENTED_IMAGE_SIMPLE, description: 'Nothing booked today' })),
      h(Section, { title: 'Upcoming appointments', count: d.upcoming.length }, d.upcoming.length ? d.upcoming.map((a) => h(Appointment, { key: a.id, a, showDay: true })) : h(Empty, { image: Empty.PRESENTED_IMAGE_SIMPLE, description: 'No upcoming appointments' })),
      h(
        Section,
        { title: 'Upcoming shifts', count: d.shifts.length },
        d.shifts.length
          ? d.shifts.map((s) => h('div', { key: s.id, className: 'bw-ws-row' }, h('div', { className: 'bw-ws-when' }, day(s.startTime)), h('div', { className: 'bw-ws-main' }, `${time(s.startTime)} – ${time(s.endTime)}`, ' ', h(Tag, { color: STATUS_COLOR[s.status] || 'default' }, label(s.status)))))
          : h(Empty, { image: Empty.PRESENTED_IMAGE_SIMPLE, description: 'No upcoming shifts' }),
      ),
      h(
        Section,
        { title: 'My customers', count: d.customers.length },
        d.customers.length
          ? d.customers.slice(0, 12).map((c) =>
              h(
                'div',
                { key: c.id, className: 'bw-ws-row' },
                h(
                  'div',
                  { className: 'bw-ws-main' },
                  h('div', null, c.name || 'Customer'),
                  h('div', { className: 'bw-ws-sub' }, [c.phone, c.lastSeen ? `last/next visit ${day(c.lastSeen)}` : null].filter(Boolean).join(' · ')),
                  sensitivities(c).length ? h('div', { className: 'bw-ws-sub', style: { color: '#cf1322', opacity: 1 } }, '⚠ ', sensitivities(c).join(', ')) : null,
                ),
              ),
            )
          : h(Empty, { image: Empty.PRESENTED_IMAGE_SIMPLE, description: 'No customers yet' }),
      ),
      h(
        Section,
        { title: 'Recent customer notes', count: d.notes.length },
        d.notes.length
          ? d.notes.map((n) => h('div', { key: n.id, className: 'bw-ws-row' }, h('div', { className: 'bw-ws-main' }, h('div', { className: 'bw-ws-sub' }, [n.customer, day(n.createdAt), n.mine ? 'my note' : 'front desk'].filter(Boolean).join(' · ')), h('div', null, n.note))))
          : h(Empty, { image: Empty.PRESENTED_IMAGE_SIMPLE, description: 'No notes yet' }),
      ),
    ),
  );
}

ctx.render(h(Workspace));
