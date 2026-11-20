/* BW-REVIEWS:BEGIN staff-review-scores v2 (T-05). Inserted by scripts/apply-customer-reviews.js; do not edit inside the block. */
// Client Review Scores section of Statistics → Staff Performance.
// Lives inside the BW-STATS block and uses its helpers (h, hooks, Section, Empty, Spin, Alert, Typography, theme,
// bwStaffName) and its filters: the selected range (inst = [from, to) instants in the business time zone) and the
// Technician selector (who). Reviews are filtered by submittedAt, not appointment date.
// Data comes pre-aggregated from customerReviewAdmin:scores (counts, sums and the 1–5 distribution per technician).
// No customer names or comments are loaded here.
function BwReviewStars({ value, size }) {
  const { token } = theme.useToken();
  const px = size || 16;
  const pct = Math.max(0, Math.min(1, Number(value || 0) / 5)) * 100;
  const row = (color) =>
    h('span', { 'aria-hidden': 'true', style: { fontSize: px, letterSpacing: 1, color, whiteSpace: 'nowrap', lineHeight: 1 } }, '★★★★★');
  return h(
    'span',
    { style: { position: 'relative', display: 'inline-block', lineHeight: 1 } },
    row(token.colorBorder),
    h('span', { style: { position: 'absolute', left: 0, top: 0, overflow: 'hidden', width: pct + '%' } }, row('#b07f45')),
  );
}

function BwReviewScores({ inst, who, staff, techs, rangeText, oneCol, reload }) {
  const { token } = theme.useToken();
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const reqId = useRef(0);
  const from = inst ? new Date(inst.from).toISOString() : null;
  const to = inst ? new Date(inst.to).toISOString() : null;
  useEffect(() => {
    if (!from || !to) return;
    const id = ++reqId.current;
    setState((s) => Object.assign({}, s, { loading: true, error: null }));
    ctx.api
      .request({ url: 'customerReviewAdmin:scores', method: 'post', data: { from, to, staffId: who }, skipNotify: true })
      .then(
        (res) => { if (id === reqId.current) setState({ loading: false, error: null, data: (res && res.data && res.data.data) || { staff: [] } }); },
        (err) => {
          if (id !== reqId.current) return;
          const status = err && err.response && err.response.status;
          const msg = status === 404 ? 'Client reviews are not set up (enable @salon/plugin-customer-reviews).'
            : status === 401 || status === 403 ? 'You do not have permission to view client review scores.'
            : (err && err.message) || 'Could not load client review scores.';
          setState({ loading: false, error: msg, data: null });
        });
  }, [from, to, who, reload]);

  const names = useMemo(() => {
    const m = {};
    (staff || []).forEach((s) => { m[String(s.id)] = bwStaffName(s); });
    (techs || []).forEach((t) => { m[String(t.key)] = t.name; });
    return m;
  }, [staff, techs]);

  const sub = 'Average customer rating out of 5, by review submission date' + (rangeText ? ' (' + rangeText + ')' : '') + '. Every submitted review counts, including low and flagged ones.';
  if (!inst) return h(Section, { title: 'Client Review Scores', sub }, h(Typography.Text, { type: 'secondary' }, 'Choose a valid date range.'));
  if (state.error) return h(Section, { title: 'Client Review Scores', sub }, h(Alert, { type: 'warning', showIcon: true, message: state.error }));
  if (state.loading && !state.data) return h(Section, { title: 'Client Review Scores', sub }, h('div', { style: { padding: 16, textAlign: 'center' } }, h(Spin, null)));

  const scores = {};
  ((state.data && state.data.staff) || []).forEach((s) => { scores[String(s.staffId)] = s; });
  const minRankable = (state.data && state.data.minRankable) || 5;
  // Rows: the selected technician, or every technician in the selector plus anyone else who was reviewed.
  let keys;
  if (who && who !== 'all') keys = [String(who)];
  else {
    keys = (techs || []).map((t) => String(t.key));
    Object.keys(scores).forEach((k) => { if (keys.indexOf(k) < 0) keys.push(k); });
  }
  const rows = keys.map((k) => ({ key: k, name: names[k] || 'Staff #' + k, s: scores[k] || null }))
    // Alphabetical, not ranked: a leaderboard from a handful of reviews would mislead.
    .sort((a, b) => a.name.localeCompare(b.name));
  const total = rows.reduce((n, r) => n + (r.s ? r.s.count : 0), 0);
  const sum = rows.reduce((n, r) => n + (r.s ? r.s.sum : 0), 0);
  const fmt1 = (v) => (Math.round(v * 10) / 10).toFixed(1);

  const summary = total
    ? h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginBottom: 12 } },
        h('span', { style: { fontSize: 28, fontWeight: 600, lineHeight: 1 } }, fmt1(sum / total)),
        h(BwReviewStars, { value: sum / total, size: 20 }),
        h('span', { style: { fontSize: 13, color: token.colorTextSecondary } }, 'out of 5 from ' + total + ' review' + (total === 1 ? '' : 's') + (who && who !== 'all' ? '' : ' across all technicians')))
    : null;

  const card = (r) => {
    const s = r.s;
    const box = { border: '1px solid ' + token.colorBorderSecondary, borderRadius: token.borderRadius, padding: '10px 12px', minWidth: 0 };
    if (!s || !s.count) {
      return h('div', { key: r.key, style: box },
        h('div', { style: { fontWeight: 600, overflowWrap: 'anywhere' } }, r.name),
        h('div', { style: { fontSize: 13, color: token.colorTextSecondary, marginTop: 4 } }, 'No reviews yet'));
    }
    const avg = s.sum / s.count;
    const max = Math.max.apply(null, s.distribution);
    return h('div', { key: r.key, style: box, 'aria-label': r.name + ': ' + fmt1(avg) + ' out of 5 from ' + s.count + ' reviews' },
      h('div', { style: { fontWeight: 600, overflowWrap: 'anywhere' } }, r.name),
      h('div', { style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginTop: 4 } },
        h('span', { style: { fontSize: 18, fontWeight: 600 } }, fmt1(avg)),
        h('span', { style: { fontSize: 12, color: token.colorTextSecondary } }, '/ 5'),
        h(BwReviewStars, { value: avg, size: 15 }),
        h('span', { style: { fontSize: 12, color: token.colorTextSecondary } }, '(' + s.count + ' review' + (s.count === 1 ? '' : 's') + ')')),
      s.count < minRankable ? h('div', { style: { fontSize: 11, color: token.colorTextTertiary, marginTop: 2 } }, 'Few reviews: interpret with care') : null,
      s.flagged ? h('div', { style: { fontSize: 11, color: token.colorTextTertiary, marginTop: 2 } }, s.flagged + ' flagged for review (still counted)') : null,
      h('div', { style: { marginTop: 8, display: 'flex', flexDirection: 'column', gap: 2 }, role: 'list', 'aria-label': 'Rating distribution' },
        [5, 4, 3, 2, 1].map((star) => {
          const n = s.distribution[star - 1];
          return h('div', { key: star, role: 'listitem', style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 } },
            h('span', { style: { width: 22, color: token.colorTextSecondary } }, star + '★'),
            h('span', { 'aria-hidden': 'true', style: { flex: 1, height: 6, borderRadius: 3, background: token.colorFillSecondary, overflow: 'hidden' } },
              h('span', { style: { display: 'block', height: '100%', width: (max ? (n / max) * 100 : 0) + '%', background: '#b07f45' } })),
            h('span', { style: { width: 22, textAlign: 'right' } }, String(n)),
            h('span', { className: 'bw-sr', style: { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0,0,0,0)' } }, n + ' ' + star + '-star review' + (n === 1 ? '' : 's')));
        })));
  };

  return h(Section, { title: 'Client Review Scores', sub, extra: state.loading ? h(Spin, { size: 'small' }) : null },
    total ? null : h('div', { style: { marginBottom: rows.length ? 10 : 0 } }, h(Empty, { image: Empty.PRESENTED_IMAGE_SIMPLE, description: 'No reviews yet' })),
    summary,
    rows.length && total
      ? h('div', { style: { display: 'grid', gridTemplateColumns: oneCol ? 'minmax(0, 1fr)' : 'repeat(auto-fill, minmax(220px, 1fr))', gap: 8 } }, rows.map(card))
      : null);
}
/* BW-REVIEWS:END */
