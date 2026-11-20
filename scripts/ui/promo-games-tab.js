// "Promo Games" tab on the Messages page (JS block): spin-to-win promo games.
// Staff set up a wheel per game: segments with a label, win or no-win kind, a probability
// weight, a number of win items available (stock, 0 = unlimited) and an optional coupon prize.
// The Play dialog spins an animated SVG wheel for a chosen customer: the winner is drawn by
// weight over the still-available segments (exhausted prizes are excluded and their probability
// redistributed), and every spin is recorded in promoGameSpins. Draw rules mirror
// scripts/promo-games.js (unit-tested there).
// Deployed by scripts/apply-promo-games.js via flowSurfaces (JS block).

const React = ctx.React; const antd = ctx.antd; const dayjs = ctx.dayjs;
const { useState, useEffect, useRef } = React;
const { Input, InputNumber, Select, Button, Tag, Modal, message, Spin, Empty, Table, Popconfirm, Radio } = antd;
const h = React.createElement;

const GAMES = 'promoGames';
const ITEMS = 'promoGameItems';
const SPINS = 'promoGameSpins';
const SEGMENT_COLORS = ['#d4621c', '#0e7490', '#6d28d9', '#be185d', '#15803d', '#b45309', '#1d4ed8', '#b91c1c', '#0f766e', '#7c3aed'];

const req = async (url, params) => (await ctx.api.request({ url, params })).data;
const post = (url, data) => ctx.api.request({ url, method: 'post', data });
const errText = (e) => (e && e.response && e.response.data && e.response.data.errors && e.response.data.errors[0] && e.response.data.errors[0].message) || (e && e.message) || String(e);
const filterParam = (f) => encodeURIComponent(JSON.stringify(f));

// ── Draw rules (same as scripts/promo-games.js) ──
const eligibleItems = (items, winCountByItemId = {}) => (items || []).filter((item) => {
  if (!item || !(Number(item.weight) > 0)) return false;
  if (item.kind === 'noWin') return true;
  const limit = Number(item.winLimit) || 0;
  if (!limit) return true;
  return (winCountByItemId[item.id] || 0) < limit;
});
const pickWeighted = (items, random = Math.random) => {
  const pool = (items || []).filter((i) => Number(i.weight) > 0);
  const total = pool.reduce((s, i) => s + Number(i.weight), 0);
  if (!total) return null;
  let roll = random() * total;
  for (const item of pool) { roll -= Number(item.weight); if (roll < 0) return item; }
  return pool[pool.length - 1];
};
const probabilities = (items) => {
  const pool = (items || []).filter((i) => Number(i.weight) > 0);
  const total = pool.reduce((s, i) => s + Number(i.weight), 0);
  const out = {};
  for (const item of pool) out[item.id] = total ? Math.round((Number(item.weight) / total) * 1000) / 10 : 0;
  return out;
};
const colorOf = (item, index) => item.color || SEGMENT_COLORS[index % SEGMENT_COLORS.length];

// ── SVG wheel ──
const polar = (cx, cy, r, deg) => { const rad = ((deg - 90) * Math.PI) / 180; return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)]; };
function segmentPath(cx, cy, r, startDeg, endDeg) {
  const [x1, y1] = polar(cx, cy, r, startDeg);
  const [x2, y2] = polar(cx, cy, r, endDeg);
  const large = endDeg - startDeg > 180 ? 1 : 0;
  return `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`;
}

function Wheel({ items, rotation, spinning, size = 300 }) {
  const cx = size / 2; const cy = size / 2; const r = size / 2 - 6;
  // Equal slices for every segment: the look is even, the actual chance stays weight-based.
  const sweep = 360 / (items.length || 1);
  const segments = items.map((item, idx) => {
    const start = idx * sweep; const mid = start + sweep / 2;
    const [lx, ly] = polar(cx, cy, r * 0.65, mid);
    return { item, idx, start, end: start + sweep, mid, lx, ly };
  });
  return h('div', { style: { position: 'relative', width: size, height: size, margin: '0 auto' } },
    h('div', { style: { position: 'absolute', top: -4, left: '50%', transform: 'translateX(-50%)', zIndex: 2, width: 0, height: 0, borderLeft: '12px solid transparent', borderRight: '12px solid transparent', borderTop: '20px solid #111827' } }),
    h('svg', { width: size, height: size, viewBox: `0 0 ${size} ${size}` },
      h('g', { style: { transform: `rotate(${rotation}deg)`, transformOrigin: `${cx}px ${cy}px`, transition: spinning ? 'transform 4.5s cubic-bezier(0.15, 0.85, 0.25, 1)' : 'none' } },
        segments.map((s) => h('g', { key: s.item.id },
          h('path', { d: segmentPath(cx, cy, r, s.start, s.end), fill: colorOf(s.item, s.idx), stroke: '#fff', strokeWidth: 2 }),
          h('text', { x: s.lx, y: s.ly, fill: '#fff', fontSize: 12, fontWeight: 600, textAnchor: 'middle', dominantBaseline: 'middle', transform: `rotate(${s.mid} ${s.lx} ${s.ly})` },
            String(s.item.label || '').slice(0, 14)))),
        h('circle', { cx, cy, r: 26, fill: '#fff', stroke: '#e5e7eb', strokeWidth: 2 }),
        h('text', { x: cx, y: cy, textAnchor: 'middle', dominantBaseline: 'middle', fontSize: 11, fill: '#6b7280' }, 'SPIN'))));
}

// ── Game editor (create / edit segments) ──
function GameEditorModal({ open, onClose, game, onSaved }) {
  const [name, setName] = useState('');
  const [rows, setRows] = useState([]);
  const [removed, setRemoved] = useState([]);
  const [coupons, setCoupons] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const blankRow = () => ({ key: 'n' + Math.random().toString(36).slice(2, 8), label: '', kind: 'win', weight: 1, winLimit: 0, couponId: null, color: null });

  useEffect(() => {
    if (!open) return;
    setRemoved([]);
    // Fetch fresh every time the editor opens, so coupons created moments ago show up.
    (async () => {
      try { const r = await req('coupons:list?paginate=false&fields[]=id&fields[]=code&fields[]=name&filter=' + filterParam({ status: 'active' }) + '&sort=name'); setCoupons(r.data || []); }
      catch (e) { setCoupons([]); }
    })();
    if (!game) { setName(''); setRows([{ ...blankRow(), label: 'Grand prize', winLimit: 1 }, { ...blankRow(), label: '10% off' }, { ...blankRow(), label: 'Try again', kind: 'noWin', weight: 2 }]); return; }
    setName(game.name || '');
    setLoading(true);
    (async () => {
      try {
        const r = await req(ITEMS + ':list?paginate=false&filter=' + filterParam({ gameId: game.id }) + '&sort=createdAt');
        setRows((r.data || []).map((i) => ({ key: 'e' + i.id, id: i.id, label: i.label || '', kind: i.kind || 'win', weight: Number(i.weight) || 0, winLimit: Number(i.winLimit) || 0, couponId: i.couponId || null, color: i.color || null })));
      } catch (e) { message.error(errText(e)); setRows([]); }
      finally { setLoading(false); }
    })();
  }, [open]);

  const setRow = (key, patch) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const removeRow = (row) => { setRows((rs) => rs.filter((r) => r.key !== row.key)); if (row.id) setRemoved((d) => [...d, row.id]); };
  const probs = probabilities(rows.map((r) => ({ ...r, id: r.key })));
  const canSave = name.trim() && rows.length >= 2 && rows.every((r) => r.label.trim() && Number(r.weight) > 0);

  const save = async () => {
    setSaving(true);
    try {
      let gameId = game && game.id;
      if (!gameId) {
        const created = await post(GAMES + ':create', { name: name.trim(), status: 'active' });
        gameId = created.data.data.id;
      } else if (name.trim() !== game.name) {
        await post(GAMES + ':update?filterByTk=' + gameId, { name: name.trim() });
      }
      for (const id of removed) await post(ITEMS + ':destroy?filterByTk=' + id);
      for (const r of rows) {
        const data = { game: { id: gameId }, label: r.label.trim(), kind: r.kind, weight: r.weight, winLimit: r.kind === 'win' ? (r.winLimit || 0) : 0, coupon: r.kind === 'win' && r.couponId ? { id: r.couponId } : null, color: r.color || null };
        if (r.id) await post(ITEMS + ':update?filterByTk=' + r.id, data);
        else await post(ITEMS + ':create', data);
      }
      message.success('Game saved.');
      onSaved(); onClose();
    } catch (e) { message.error('Could not save: ' + errText(e)); }
    finally { setSaving(false); }
  };

  const columns = [
    { title: 'Segment', width: 170, render: (r) => h(Input, { size: 'small', value: r.label, maxLength: 40, placeholder: 'e.g. Free blowout', onChange: (e) => setRow(r.key, { label: e.target.value }) }) },
    { title: 'Kind', width: 120, render: (r) => h(Select, { size: 'small', value: r.kind, style: { width: '100%' }, onChange: (v) => setRow(r.key, { kind: v }), options: [{ value: 'win', label: 'Win' }, { value: 'noWin', label: 'No win' }] }) },
    { title: 'Weight', width: 90, render: (r) => h(InputNumber, { size: 'small', min: 0.1, value: r.weight, style: { width: '100%' }, onChange: (v) => setRow(r.key, { weight: v || 0 }) }) },
    { title: 'Chance', width: 70, render: (r) => h('span', { style: { fontSize: 12, color: '#6b7280' } }, (probs[r.key] || 0) + '%') },
    { title: '# Win items', width: 100, render: (r) => r.kind === 'win' ? h(InputNumber, { size: 'small', min: 0, precision: 0, value: r.winLimit, style: { width: '100%' }, onChange: (v) => setRow(r.key, { winLimit: v || 0 }) }) : h('span', { style: { color: '#bfbfbf' } }, '—') },
    { title: 'Coupon prize', width: 150, render: (r) => r.kind === 'win' ? h(Select, { size: 'small', allowClear: true, showSearch: true, optionFilterProp: 'label', value: r.couponId, style: { width: '100%' }, placeholder: 'None', onChange: (v) => setRow(r.key, { couponId: v || null }), options: coupons.map((c) => ({ value: c.id, label: c.name || c.code })) }) : h('span', { style: { color: '#bfbfbf' } }, '—') },
    { title: '', width: 40, render: (r) => h(Button, { size: 'small', type: 'text', danger: true, onClick: () => removeRow(r) }, '✕') },
  ];

  return h(Modal, {
    open, title: game ? 'Edit ' + (game.name || 'game') : 'New spin-to-win game', onCancel: onClose, width: 820, destroyOnClose: true,
    footer: [h(Button, { key: 'c', onClick: onClose }, 'Cancel'), h(Button, { key: 's', type: 'primary', loading: saving, disabled: !canSave, onClick: save }, 'Save game')],
  },
  loading ? h('div', { style: { textAlign: 'center', padding: 30 } }, h(Spin)) :
  h('div', null,
    h('div', { style: { fontWeight: 600, marginBottom: 4 } }, 'Game name'),
    h(Input, { value: name, maxLength: 80, placeholder: 'Holiday spin & win', onChange: (e) => setName(e.target.value), style: { marginBottom: 14 } }),
    h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 } },
      h('span', { style: { fontWeight: 600 } }, 'Wheel segments'),
      h(Button, { size: 'small', onClick: () => setRows((rs) => [...rs, blankRow()]) }, '+ Add segment')),
    h(Table, { rowKey: 'key', dataSource: rows, columns, pagination: false, size: 'small' }),
    h('div', { style: { fontSize: 12, color: '#8c8c8c', marginTop: 8 } },
      'Chance = weight ÷ total weight. A win segment that has given away all its items is removed from the draw and the remaining chances are redistributed. At least 2 segments are needed.')));
}

// ── Play dialog ──
function PlayModal({ open, onClose, game, onSpun }) {
  const [customers, setCustomers] = useState([]);
  const [customerId, setCustomerId] = useState(null);
  const [items, setItems] = useState(null);
  const [winCounts, setWinCounts] = useState({});
  const [rotation, setRotation] = useState(0);
  const [spinning, setSpinning] = useState(false);
  const [result, setResult] = useState(null);
  const seq = useRef(0);

  const search = async (q) => {
    const my = ++seq.current;
    try {
      const text = String(q || '').trim();
      const params = { pageSize: 20, fields: ['id', 'firstName', 'lastName', 'email'], sort: ['firstName'] };
      if (text) params.filter = { $or: [{ firstName: { $includes: text } }, { lastName: { $includes: text } }, { email: { $includes: text } }] };
      const r = await req('customers:list', params);
      if (my === seq.current) setCustomers(r.data || []);
    } catch (e) { /* keep previous */ }
  };
  const loadWheel = async () => {
    try {
      const r = await req(ITEMS + ':list?paginate=false&filter=' + filterParam({ gameId: game.id }) + '&sort=createdAt&appends[]=coupon');
      const s = await req(SPINS + ':list?paginate=false&fields[]=id&fields[]=itemId&fields[]=won&filter=' + filterParam({ gameId: game.id }));
      const counts = {};
      for (const x of (s.data || [])) if (x.won) counts[x.itemId] = (counts[x.itemId] || 0) + 1;
      setWinCounts(counts);
      setItems(r.data || []);
    } catch (e) { message.error(errText(e)); setItems([]); }
  };
  useEffect(() => { if (open && game) { setCustomerId(null); setResult(null); setRotation(0); setSpinning(false); setItems(null); search(''); loadWheel(); } }, [open]);

  if (!game) return null;
  const wheelItems = items ? eligibleItems(items, winCounts) : [];
  const canSpin = customerId && !spinning && wheelItems.length > 0;

  const spin = () => {
    const winner = pickWeighted(wheelItems);
    if (!winner) { message.warning('Nothing left to win on this wheel.'); return; }
    // Where the winner's segment centre sits on the drawn wheel (equal slices):
    const sweep = 360 / (wheelItems.length || 1);
    const index = wheelItems.findIndex((item) => item.id === winner.id);
    const mid = (index < 0 ? 0 : index) * sweep + sweep / 2;
    const target = rotation - (rotation % 360) + 6 * 360 + (360 - mid);
    setResult(null); setSpinning(true); setRotation(target);
    setTimeout(async () => {
      setSpinning(false);
      const won = winner.kind !== 'noWin';
      setResult({ item: winner, won });
      try {
        await post(SPINS + ':create', { game: { id: game.id }, item: { id: winner.id }, customer: { id: customerId }, spunAt: new Date().toISOString(), won });
        if (won) setWinCounts((c) => ({ ...c, [winner.id]: (c[winner.id] || 0) + 1 }));
        onSpun();
      } catch (e) { message.error('Could not record the spin: ' + errText(e)); }
    }, 4700);
  };

  return h(Modal, {
    open, title: 'Play: ' + (game.name || ''), onCancel: spinning ? undefined : onClose, width: 560, destroyOnClose: true, maskClosable: false,
    footer: [h(Button, { key: 'close', disabled: spinning, onClick: onClose }, 'Close'),
      h(Button, { key: 'spin', type: 'primary', size: 'large', loading: spinning, disabled: !canSpin, onClick: spin }, spinning ? 'Spinning…' : 'Spin!')],
  },
  h('div', null,
    h('div', { style: { fontWeight: 600, marginBottom: 4 } }, 'Customer'),
    h(Select, {
      showSearch: true, filterOption: false, value: customerId, onSearch: search, onChange: setCustomerId, disabled: spinning,
      placeholder: 'Search customer…', style: { width: '100%', marginBottom: 16 },
      options: customers.map((c) => ({ value: c.id, label: [c.firstName, c.lastName].filter(Boolean).join(' ') + (c.email ? ' · ' + c.email : '') })),
    }),
    items === null ? h('div', { style: { textAlign: 'center', padding: 40 } }, h(Spin)) :
    wheelItems.length === 0 ? h(Empty, { image: Empty.PRESENTED_IMAGE_SIMPLE, description: 'No segments left to land on. Edit the game to add segments or stock.' }) :
    h('div', null,
      h(Wheel, { items: wheelItems, rotation, spinning }),
      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'center', marginTop: 12 } },
        wheelItems.map((i, idx) => h('span', { key: i.id, style: { fontSize: 12, color: '#4b5563' } },
          h('span', { style: { display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: colorOf(i, idx), marginRight: 4 } }),
          i.label + (Number(i.winLimit) ? ' (' + Math.max(0, Number(i.winLimit) - (winCounts[i.id] || 0)) + ' left)' : '')))),
      result && h('div', { style: { marginTop: 14, padding: '12px 16px', borderRadius: 8, textAlign: 'center', background: result.won ? '#f6ffed' : '#fafafa', border: '1px solid ' + (result.won ? '#b7eb8f' : '#e5e7eb') } },
        h('div', { style: { fontSize: 18, fontWeight: 700 } }, result.won ? '🎉 ' + result.item.label + '!' : result.item.label),
        result.won && result.item.coupon && h('div', { style: { marginTop: 6 } }, 'Coupon: ',
          h('span', { style: { fontFamily: 'monospace', fontWeight: 600, background: '#fff2e8', padding: '2px 8px', borderRadius: 4, border: '1px dashed #d4621c' } }, result.item.coupon.code)),
        !result.won && h('div', { style: { fontSize: 12, color: '#8c8c8c', marginTop: 4 } }, 'Better luck next time.')))));
}

// ── Panel ──
function PromoGamesPanel() {
  const [games, setGames] = useState(null);
  const [itemsByGame, setItemsByGame] = useState({});
  const [statsByGame, setStatsByGame] = useState({});
  const [recent, setRecent] = useState([]);
  const [editorFor, setEditorFor] = useState(null);   // null closed | {game: null|row}
  const [playFor, setPlayFor] = useState(null);

  const load = async () => {
    try {
      const g = await req(GAMES + ':list?paginate=false&sort=-createdAt');
      const rows = g.data || [];
      setGames(rows);
      if (rows.length) {
        const ids = rows.map((x) => x.id);
        const it = await req(ITEMS + ':list?paginate=false&filter=' + filterParam({ gameId: { $in: ids } }));
        const grouped = {};
        for (const x of (it.data || [])) (grouped[x.gameId] = grouped[x.gameId] || []).push(x);
        setItemsByGame(grouped);
        const sp = await req(SPINS + ':list?paginate=false&fields[]=id&fields[]=gameId&fields[]=won&filter=' + filterParam({ gameId: { $in: ids } }));
        const stats = {};
        for (const x of (sp.data || [])) { const s = (stats[x.gameId] = stats[x.gameId] || { spins: 0, wins: 0 }); s.spins++; if (x.won) s.wins++; }
        setStatsByGame(stats);
      } else { setItemsByGame({}); setStatsByGame({}); }
      const rec = await req(SPINS + ':list?pageSize=10&sort=-spunAt&appends[]=customer&appends[]=item&appends[]=game');
      setRecent(rec.data || []);
    } catch (e) { setGames([]); message.error('Could not load games: ' + errText(e)); }
  };
  useEffect(() => { load(); }, []);

  const setStatus = async (game, status) => {
    try { await post(GAMES + ':update?filterByTk=' + game.id, { status }); message.success(game.name + (status === 'active' ? ' enabled.' : ' disabled.')); load(); }
    catch (e) { message.error(errText(e)); }
  };
  // Public play link: generate the secret token on first copy, then reuse it. The link opens
  // scripts/ui/promo-play.html (served by the CRM plugin), where the customer enters their
  // email and spins; a win emails them the coupon code automatically.
  const copyLink = async (game) => {
    try {
      let token = game.publicToken;
      if (!token) {
        token = 'pg';
        for (let i = 0; i < 24; i++) token += 'abcdefghijkmnpqrstuvwxyz23456789'[Math.floor(Math.random() * 32)];
        await post(GAMES + ':update?filterByTk=' + game.id, { publicToken: token });
        load();
      }
      const link = window.location.origin + '/api/promoPlay:page?token=' + token;
      try { await navigator.clipboard.writeText(link); message.success('Play link copied. Paste it into an email or message.'); }
      catch (clipErr) { Modal.info({ title: 'Play link', content: h(Input, { value: link, readOnly: true }) }); }
    } catch (e) { message.error('Could not create the link: ' + errText(e)); }
  };
  const remove = async (game) => {
    try { await post(GAMES + ':destroy?filterByTk=' + game.id); message.success(game.name + ' deleted.'); load(); }
    catch (e) { message.error(errText(e)); }
  };

  const columns = [
    { title: 'Game', dataIndex: 'name', render: (v) => h('strong', null, v) },
    { title: 'Segments', render: (g) => {
      const items = itemsByGame[g.id] || [];
      const probs = probabilities(items);
      return h('span', { style: { fontSize: 12 } }, items.map((i, idx) => h(Tag, { key: i.id, style: { marginBottom: 2 }, color: i.kind === 'noWin' ? 'default' : undefined },
        i.label + ' ' + (probs[i.id] || 0) + '%' + (Number(i.winLimit) ? ' ×' + i.winLimit : ''))));
    } },
    { title: 'Spins', render: (g) => { const s = statsByGame[g.id] || { spins: 0, wins: 0 }; return s.spins + ' (' + s.wins + ' wins)'; } },
    { title: 'Status', render: (g) => h(Tag, { color: g.status === 'active' ? 'green' : 'default' }, g.status) },
    { title: 'Actions', render: (g) => h('span', { style: { whiteSpace: 'nowrap' } },
      h(Button, { size: 'small', type: 'primary', disabled: g.status !== 'active' || !(itemsByGame[g.id] || []).length, onClick: () => setPlayFor(g), style: { marginRight: 4 } }, 'Play'),
      h(Button, { size: 'small', disabled: g.status !== 'active' || !(itemsByGame[g.id] || []).length, onClick: () => copyLink(g), style: { marginRight: 4 } }, 'Copy link'),
      h(Button, { size: 'small', type: 'link', onClick: () => setEditorFor({ game: g }) }, 'Edit'),
      g.status === 'active'
        ? h(Button, { size: 'small', type: 'link', onClick: () => setStatus(g, 'disabled') }, 'Disable')
        : h(Button, { size: 'small', type: 'link', onClick: () => setStatus(g, 'active') }, 'Enable'),
      h(Popconfirm, { title: 'Delete ' + g.name + '?', description: 'Its spin history is kept.', onConfirm: () => remove(g) },
        h(Button, { size: 'small', type: 'link', danger: true }, 'Delete'))) },
  ];

  return h('div', { style: { background: '#fff', border: '1px solid #f0f0f0', borderRadius: 8, padding: 16 } },
    h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, flexWrap: 'wrap', gap: 8 } },
      h('div', null,
        h('div', { style: { fontWeight: 600, fontSize: 16 } }, 'Promo games'),
        h('div', { style: { fontSize: 12, color: '#8c8c8c' } }, 'Spin-to-win wheels with prize stock and weighted probabilities. Spin for a customer in store.')),
      h('div', { style: { display: 'flex', gap: 8 } },
        h(Button, { onClick: load }, 'Refresh'),
        h(Button, { type: 'primary', onClick: () => setEditorFor({ game: null }) }, '+ New game'))),
    games === null ? h('div', { style: { textAlign: 'center', padding: 40 } }, h(Spin)) :
    games.length === 0 ? h(Empty, { image: Empty.PRESENTED_IMAGE_SIMPLE, description: 'No promo games yet. Create your first spin-to-win wheel.' }) :
    h(Table, { rowKey: 'id', dataSource: games, columns, pagination: false, size: 'middle', scroll: { x: true } }),
    recent.length > 0 && h('div', { style: { marginTop: 18 } },
      h('div', { style: { fontWeight: 600, marginBottom: 6 } }, 'Recent spins'),
      h(Table, {
        rowKey: 'id', size: 'small', pagination: false, dataSource: recent,
        columns: [
          { title: 'When', render: (s) => (s.spunAt ? dayjs(s.spunAt).format('MMM D, h:mm A') : '') },
          { title: 'Game', render: (s) => (s.game && s.game.name) || '' },
          { title: 'Customer', render: (s) => s.customer ? [s.customer.firstName, s.customer.lastName].filter(Boolean).join(' ') : '' },
          { title: 'Result', render: (s) => h('span', null, (s.item && s.item.label) || '', ' ', s.won ? h(Tag, { color: 'green' }, 'win') : h(Tag, null, 'no win')) },
        ],
      })),
    editorFor && h(GameEditorModal, { open: !!editorFor, onClose: () => setEditorFor(null), game: editorFor.game, onSaved: load }),
    h(PlayModal, { open: !!playFor, onClose: () => setPlayFor(null), game: playFor, onSpun: load }));
}

ctx.render(h(PromoGamesPanel));
