
const CFG = {"collection":"appointments","table":"yldxyya1moi","noun":"Appointments","search":{"fields":["customer.firstName","customer.lastName","staff.firstName","notes"],"placeholder":"Search customer, staff or notes"},"selects":[{"field":"status","placeholder":"All statuses"},{"field":"staffId","placeholder":"All staff","rel":{"collection":"staff","label":["firstName","lastName"]}}],"dateRange":{"field":"appointmentDate","label":"Date","dateOnly":true},"kpis":[{"label":"Scheduled","select":"status","value":"scheduled","color":"#2563eb"},{"label":"Confirmed","select":"status","value":"confirmed","color":"#0891b2"},{"label":"Completed","select":"status","value":"completed","color":"#16a34a"},{"label":"Cancelled","select":"status","value":"cancelled","color":"#dc2626"},{"label":"No show","select":"status","value":"noShow","color":"#ea580c"}],"columns":[{"key":"customer.firstName","label":"Customer","rel":{"collection":"customers","label":["firstName","lastName"]}},{"key":"staff.firstName","label":"Staff","rel":{"collection":"staff","label":["firstName","lastName"]}},{"key":"category","label":"Category"},{"key":"appointmentDate","label":"Date"},{"key":"startTime","label":"Start time"},{"key":"endTime","label":"End time"},{"key":"status","label":"Status"},{"key":"notes","label":"Notes"}]};
// Type tabs (All / Sessions / Events). The list is injected from scripts/appointments-schema.js
// (CATEGORY_TABS) when the page blueprint is built; each tab carries its server-side filter, so the
// category values are never restated here. An empty list degrades to a single "All" tab.
const TABS = /*APPOINTMENT_TABS*/[];
const TAB_LIST = TABS.length ? TABS : [{ key: 'all', label: 'All', filter: {} }];
const DEFAULT_TAB = TAB_LIST[0].key;
const TAB_PARAM = 'tab';
const tabByKey = (key) => TAB_LIST.find((t) => t.key === key) || TAB_LIST[0];
const React = ctx.React; const antd = ctx.antd; const dayjs = ctx.dayjs;
const { useState, useEffect, useRef, useMemo } = React;
const { Input, Select, DatePicker, Button, Space, Upload, message, Tooltip, Tabs } = antd;
const h = React.createElement;
const GROUP = 'toolbar-' + CFG.table;
const clean = (s) => String(s ?? '').replace(/^\{\{\s*t\(\s*["'](.*)["']\s*\)\s*\}\}$/, '$1');
// Resolve the appointments table on this page dynamically so the toolbar survives page re-authoring
// (block uids change whenever the page blueprint is re-applied). CFG.table is only a last resort.
const isAppointmentsTable = (m) => {
  if (!m || m === ctx.model) return false;
  const init = typeof m.getStepParams === 'function' ? m.getStepParams('resourceSettings', 'init') : null;
  const coll = (init && init.collectionName) || (m.collection && m.collection.name);
  return coll === CFG.collection && !!m.resource;
};
const getTable = () => {
  const siblings = (ctx.model && ctx.model.parent && ctx.model.parent.subModels && ctx.model.parent.subModels.items) || [];
  return siblings.find(isAppointmentsTable) || (CFG.table ? ctx.engine.getModel(CFG.table) : null);
};
// The table may not exist yet when the toolbar first renders (sibling blocks mount independently).
const whenTableReady = async () => {
  for (let i = 0; i < 50; i++) {
    const t = getTable();
    if (t && t.resource && !t.resource.loading) return t;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return getTable();
};
const req = async (url, params) => (await ctx.api.request({ url, params })).data;
const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);

// The selected tab lives in the URL (?tab=events) so a filtered view can be bookmarked or shared.
// It is written with replace so switching tabs does not fill the browser history.
// (RunJS rejects some browser globals, so the query string is handled as plain text.)
const parseQuery = (search) => String(search || '').replace(/^\?/, '').split('&').filter(Boolean).map((pair) => { const i = pair.indexOf('='); return i < 0 ? [pair, ''] : [pair.slice(0, i), pair.slice(i + 1)]; });
const readTabFromUrl = () => {
  try {
    const hit = parseQuery(window.location.search).find((pair) => pair[0] === TAB_PARAM);
    return tabByKey(hit ? decodeURIComponent(hit[1]) : null).key;
  } catch (e) { return DEFAULT_TAB; }
};
const writeTabToUrl = (key) => {
  try {
    const pairs = parseQuery(window.location.search).filter((pair) => pair[0] !== TAB_PARAM);
    if (key !== DEFAULT_TAB) pairs.push([TAB_PARAM, encodeURIComponent(key)]);
    const search = pairs.map((pair) => pair[0] + '=' + pair[1]).join('&');
    const url = window.location.pathname + (search ? '?' + search : '') + window.location.hash;
    if (ctx.router && typeof ctx.router.navigate === 'function') ctx.router.navigate(url, { replace: true });
    else window.history.replaceState(window.history.state, '', url);
  } catch (e) { /* the URL is a convenience; the tab works without it */ }
};

// Every list request goes through the server, so the authenticated user's ACL scope is always applied
// together with these filters. Rows are never fetched just to be filtered here.
function buildFilter(st, opts = {}) {
  const and = [];
  const q = (st.q || '').trim();
  if (q && CFG.search) and.push({ $or: CFG.search.fields.map((f) => ({ [f]: { $includes: q } })) });
  (CFG.selects || []).forEach((s) => {
    const v = st.sel[s.field];
    if (opts.skipSelect && opts.skipSelect === s.field) return;
    if (v !== undefined && v !== null && v !== '') and.push({ [s.field]: { $eq: v } });
  });
  if (CFG.dateRange && st.range && st.range[0] && st.range[1]) {
    const f = CFG.dateRange.field;
    if (CFG.dateRange.dateOnly) and.push({ [f]: { $gte: st.range[0].format('YYYY-MM-DD') } }, { [f]: { $lte: st.range[1].format('YYYY-MM-DD') } });
    else and.push({ [f]: { $gte: st.range[0].startOf('day').toISOString() } }, { [f]: { $lte: st.range[1].endOf('day').toISOString() } });
  }
  if (!opts.skipTab) {
    const tabFilter = tabByKey(st.tab).filter;
    if (tabFilter && Object.keys(tabFilter).length) and.push(tabFilter);
  }
  return and.length ? { $and: and } : {};
}
const merge = (a, b) => { const x = [a, b].filter((f) => f && Object.keys(f).length); return x.length ? { $and: x } : {}; };
const hasOtherFilters = (st) => !!((st.q || '').trim() || Object.values(st.sel).some((v) => v !== undefined && v !== null && v !== '') || (st.range && st.range[0] && st.range[1]));

function parseCSV(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((v) => String(v).trim() !== ''));
}
const csvCell = (v) => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

function Toolbar() {
  const [meta, setMeta] = useState({ fields: {} });
  const [relOpts, setRelOpts] = useState({});
  const [st, setSt] = useState(() => ({ q: '', sel: {}, range: null, tab: readTabFromUrl() }));
  const [counts, setCounts] = useState({});
  const [tabCounts, setTabCounts] = useState({});
  const [busy, setBusy] = useState(false);
  const timer = useRef(); const countTimer = useRef(); const dlRef = useRef();
  const stRef = useRef(st); stRef.current = st;
  const countSeq = useRef(0);       // drops count responses that arrive after a newer request
  const selfRefresh = useRef(0);    // table refreshes started by this toolbar (not CRUD)
  const lastPage = useRef(1);       // lets pagination refreshes be told apart from CRUD refreshes

  useEffect(() => { (async () => {
    const coll = ctx.dataSourceManager.getDataSource('main').collectionManager.getCollection(CFG.collection); const c = { data: { fields: (coll ? coll.getFields() : []).map((f) => ({ name: f.name, interface: f.interface, enum: f.enum || (f.options && f.options.enum), uiSchema: f.uiSchema || (f.options && f.options.uiSchema) })) } };
    const fields = {}; (c.data.fields || []).forEach((f) => { fields[f.name] = f; });
    setMeta({ fields });
    const ro = {};
    for (const s of [...(CFG.selects || []), ...(CFG.columns || []).filter((c) => c.rel).map((c) => ({ rel: c.rel }))]) {
      if (!s.rel || ro[s.rel.collection]) continue;
      // Only the id and the label fields: the options need nothing else, and the customer record also holds
      // health-related data (skin sensitivities) that must not be loaded into the browser for a dropdown.
      const r = await req(s.rel.collection + ':list', { paginate: false, fields: ['id', ...s.rel.label] });
      ro[s.rel.collection] = (r.data || []).map((x) => ({ value: x.id, label: s.rel.label.map((k) => x[k]).filter(Boolean).join(' ') || String(x.id), raw: x }));
    }
    setRelOpts(ro);
  })().catch((e) => console.error(e)); }, []);

  const enumOpts = (field) => (meta.fields[field]?.enum || meta.fields[field]?.uiSchema?.enum || []).map((e) => ({ value: e.value, label: clean(e.label) }));
  const selOptions = (s) => s.rel ? (relOpts[s.rel.collection] || []).map(({ value, label }) => ({ value, label })) : s.options ? s.options.map(([value, label]) => ({ value, label })) : enumOpts(s.field);

  // Counts are one-row list requests (meta.count only), filtered on the server. Tab counts ignore the
  // tab itself, so switching tabs only needs the status counts again ({ tabs: false }).
  const refreshCounts = async (state, { tabs = true } = {}) => {
    const seq = ++countSeq.current;
    const kpis = {}; const tabOut = {};
    const jobs = [];
    if (tabs) {
      const base = buildFilter(state, { skipTab: true });
      TAB_LIST.forEach((t) => jobs.push(req(CFG.collection + ':list', { pageSize: 1, filter: merge(base, t.filter) }).then((r) => { tabOut[t.key] = r.meta?.count ?? 0; })));
    }
    (CFG.kpis || []).forEach((k) => {
      const f = merge(buildFilter(state, { skipSelect: k.select }), { [k.select]: { $eq: k.value } });
      jobs.push(req(CFG.collection + ':list', { pageSize: 1, filter: f }).then((r) => { kpis[k.label] = r.meta?.count ?? 0; }));
    });
    await Promise.all(jobs);
    if (seq !== countSeq.current) return;
    setCounts(kpis);
    if (tabs) setTabCounts(tabOut);
  };
  const scheduleCounts = () => {
    clearTimeout(countTimer.current);
    countTimer.current = setTimeout(() => refreshCounts(stRef.current).catch(() => {}), 200);
  };

  const apply = async (state, { tabs = true } = {}) => {
    const t = getTable(); const f = buildFilter(state);
    if (t?.resource) {
      if (Object.keys(f).length) t.resource.addFilterGroup(GROUP, f); else t.resource.removeFilterGroup(GROUP);
      t.resource.setPage(1);
      selfRefresh.current += 1;
      try { await t.resource.refresh(); }
      catch (e) { message.error('Could not load appointments: ' + (e?.message || e)); }
      finally { selfRefresh.current -= 1; lastPage.current = typeof t.resource.getPage === 'function' ? t.resource.getPage() : 1; }
    }
    refreshCounts(state, { tabs }).catch(() => {});
  };

  useEffect(() => {
    let cancelled = false; let off = null;
    if (stRef.current.tab === DEFAULT_TAB) refreshCounts(stRef.current).catch(() => {});
    (async () => {
      const t = await whenTableReady();
      if (cancelled || !t || !t.resource || typeof t.resource.on !== 'function') return;
      lastPage.current = typeof t.resource.getPage === 'function' ? t.resource.getPage() : 1;
      // A refresh the toolbar did not start means a record was created, edited or deleted (or the user
      // pressed Refresh): the tab and status counts may have changed. Page changes do not change counts.
      const onRefresh = () => {
        const page = typeof t.resource.getPage === 'function' ? t.resource.getPage() : 1;
        const paged = page !== lastPage.current; lastPage.current = page;
        if (selfRefresh.current > 0 || paged) return;
        scheduleCounts();
      };
      t.resource.on('refresh', onRefresh);
      off = () => t.resource.off('refresh', onRefresh);
      // Deep link such as ?tab=events: the table is filtered once it exists.
      if (stRef.current.tab !== DEFAULT_TAB) await apply(stRef.current);
    })().catch((e) => console.error(e));
    return () => { cancelled = true; clearTimeout(countTimer.current); clearTimeout(timer.current); if (off) off(); };
  }, []);

  const update = (patch, debounce) => {
    const next = { ...st, ...patch, sel: { ...st.sel, ...(patch.sel || {}) } };
    setSt(next); stRef.current = next;
    if ('tab' in patch && patch.tab !== st.tab) writeTabToUrl(next.tab);
    const tabOnly = Object.keys(patch).length === 1 && 'tab' in patch;
    clearTimeout(timer.current);
    if (debounce) timer.current = setTimeout(() => apply(next), 350); else apply(next, { tabs: !tabOnly });
  };
  const clearAll = () => { const n = { q: '', sel: {}, range: null, tab: st.tab }; setSt(n); stRef.current = n; apply(n); };

  const fmt = (col, v) => {
    if (v == null) return '';
    const f = meta.fields[col.key.split('.')[0]];
    if (col.key.includes('.')) return v;
    if (f?.interface === 'select') { const o = enumOpts(col.key).find((e) => e.value === v); return o ? o.label : v; }
    if (f?.interface === 'datetime' || f?.interface === 'createdAt' || f?.interface === 'updatedAt') return dayjs(v).format('YYYY-MM-DD HH:mm');
    if (f?.interface === 'checkbox') return v ? 'Yes' : 'No';
    return v;
  };

  const exportCSV = async () => {
    setBusy(true);
    try {
      const appends = [...new Set(CFG.columns.filter((c) => c.key.includes('.')).map((c) => c.key.split('.')[0]))];
      const r = await req(CFG.collection + ':list', { paginate: false, filter: buildFilter(st), appends, sort: CFG.sort || ['-createdAt'] });
      const rows = r.data || [];
      const lines = [CFG.columns.map((c) => csvCell(c.label)).join(',')];
      rows.forEach((row) => lines.push(CFG.columns.map((c) => csvCell(fmt(c, c.rel ? (getPath(row, c.key.split('.')[0]) ? c.rel.label.map((k) => getPath(row, c.key.split('.')[0])[k]).filter(Boolean).join(' ') : '') : getPath(row, c.key)))).join(',')));
      const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = dlRef.current; a.href = url; a.download = CFG.collection + '-' + dayjs().format('YYYY-MM-DD') + '.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 2000);
      message.success('Exported ' + rows.length + ' rows');
    } catch (e) { message.error('Export failed: ' + (e?.message || e)); } finally { setBusy(false); }
  };

  const toValue = (col, raw) => {
    const s = String(raw ?? '').trim(); if (s === '') return undefined;
    if (col.rel) {
      const opts = relOpts[col.rel.collection] || []; const low = s.toLowerCase();
      const hit = opts.find((o) => o.label.toLowerCase() === low) || opts.find((o) => String(o.raw[col.rel.label[0]] || '').toLowerCase() === low) || opts.find((o) => String(o.value) === s);
      if (!hit) throw new Error(col.label + ' "' + s + '" not found');
      return { id: hit.value };
    }
    const f = meta.fields[col.key];
    if (f?.interface === 'select') { const o = enumOpts(col.key).find((e) => e.label.toLowerCase() === s.toLowerCase() || String(e.value).toLowerCase() === s.toLowerCase()); if (!o) throw new Error(col.label + ' "' + s + '" is not a valid option'); return o.value; }
    if (f?.interface === 'checkbox') return /^(yes|true|1|y)$/i.test(s);
    if (f?.interface === 'number' || f?.interface === 'integer') { const n = Number(s); if (Number.isNaN(n)) throw new Error(col.label + ' "' + s + '" is not a number'); return n; }
    if (f?.interface === 'dateOnly') { const d = dayjs(s); if (!d.isValid()) throw new Error(col.label + ' "' + s + '" is not a date'); return d.format('YYYY-MM-DD'); }
    if (f?.interface === 'datetime') { const d = dayjs(s); if (!d.isValid()) throw new Error(col.label + ' "' + s + '" is not a date/time'); return d.toISOString(); }
    return s;
  };

  const importCSV = async (file) => {
    setBusy(true);
    try {
      const text = await file.text();
      const rows = parseCSV(text.replace(/^﻿/, ''));
      if (rows.length < 2) { message.warning('The CSV has no data rows'); return false; }
      const header = rows[0].map((x) => x.trim().toLowerCase());
      const cols = header.map((hd) => CFG.columns.find((c) => !c.readOnly && (c.label.toLowerCase() === hd || c.key.toLowerCase() === hd || c.key.split('.')[0].toLowerCase() === hd)) || null);
      if (!cols.some(Boolean)) { message.error('No CSV columns match this table. Export a CSV first to see the expected headers.'); return false; }
      let ok = 0; const errs = [];
      for (let i = 1; i < rows.length; i++) {
        try {
          const values = {};
          cols.forEach((c, j) => { if (!c) return; const v = toValue(c, rows[i][j]); if (v !== undefined) values[c.rel ? c.key.split('.')[0] : c.key] = v; });
          await ctx.api.request({ url: CFG.collection + ':create', method: 'post', data: values });
          ok++;
        } catch (e) { errs.push('Row ' + (i + 1) + ': ' + (e?.response?.data?.errors?.[0]?.message || e?.message || e)); }
      }
      // The table refresh below also refreshes the counts (see the refresh listener).
      const t = getTable(); if (t?.resource) await t.resource.refresh(); else scheduleCounts();
      if (errs.length) antd.Modal.warning({ title: 'Imported ' + ok + ' of ' + (rows.length - 1) + ' rows', width: 560, content: h('div', { style: { maxHeight: 300, overflow: 'auto', whiteSpace: 'pre-wrap', fontSize: 12 } }, errs.join('\n')) });
      else message.success('Imported ' + ok + ' rows');
    } catch (e) { message.error('Import failed: ' + (e?.message || e)); } finally { setBusy(false); }
    return false;
  };

  const tile = (label, value, color, active, onClick) => h('div', { key: label, onClick, style: { flex: '1 1 100px', minWidth: 96, border: '1px solid ' + (active ? '#94a3b8' : '#e5e7eb'), background: active ? '#f5f5f5' : '#fff', borderRadius: 8, padding: '10px 14px', cursor: onClick ? 'pointer' : 'default' } },
    h('div', { style: { fontSize: 12, color: '#6b7280' } }, label),
    h('div', { style: { fontSize: 20, fontWeight: 600, color: color || '#111827', marginTop: 2 } }, value ?? '–'));

  const activeTab = tabByKey(st.tab);
  const viewCount = tabCounts[st.tab];
  // antd's Tabs (rc-tabs 15.5) moves focus with the arrow keys, but Enter/Space re-activate the *current* tab
  // instead of the focused one, so a keyboard user could never switch. Select the focused tab here.
  const onTabsKeyDown = (e) => {
    if (e.key !== 'Enter' && e.key !== ' ' && e.code !== 'Space') return;
    const node = e.target && e.target.closest ? e.target.closest('[data-node-key]') : null;
    const key = node ? decodeURIComponent(node.getAttribute('data-node-key')) : null;
    if (key && TAB_LIST.some((t) => t.key === key) && key !== stRef.current.tab) { e.preventDefault(); update({ tab: key }); }
  };
  const tabsNav = h('div', { key: 'tabs', onKeyDown: onTabsKeyDown },
    h(Tabs, {
      activeKey: st.tab, onChange: (key) => update({ tab: key }), style: { marginBottom: 12 }, tabBarStyle: { marginBottom: 0 },
      items: TAB_LIST.map((t) => ({
        key: t.key,
        // the literal space keeps the accessible name readable ("Sessions 47"), not "Sessions47"
        label: h('span', null, t.label, tabCounts[t.key] !== undefined && ' ',
          tabCounts[t.key] !== undefined && h('span', { style: { marginLeft: 2, padding: '0 8px', borderRadius: 10, fontSize: 12, background: t.key === st.tab ? '#e6f4ff' : '#f5f5f5', color: t.key === st.tab ? '#1677ff' : '#6b7280' } }, tabCounts[t.key])),
      })),
    }));

  const kpiRow = h('div', { key: 'kpis', style: { display: 'flex', gap: 10, flexWrap: 'wrap', paddingBottom: 14, borderBottom: '1px solid #f0f0f0', marginBottom: 14 } },
    tile((activeTab.key === DEFAULT_TAB ? CFG.noun : activeTab.label) + ' in view', viewCount, null, !Object.values(st.sel).some((v) => v !== undefined && v !== null), () => update({ sel: Object.fromEntries((CFG.kpis || []).map((k) => [k.select, undefined])) })),
    ...(CFG.kpis || []).map((k) => tile(k.label, counts[k.label], k.color, st.sel[k.select] === k.value, () => update({ sel: { [k.select]: st.sel[k.select] === k.value ? undefined : k.value } }))));

  const filters = h('div', { key: 'filters', style: { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' } },
    CFG.search && h(Input, { key: 'q', allowClear: true, placeholder: CFG.search.placeholder || 'Search', value: st.q, onChange: (e) => update({ q: e.target.value }, true), style: { flex: '2 1 240px', minWidth: 200 }, prefix: h('span', { style: { color: '#9ca3af' } }, '⌕') }),
    ...(CFG.selects || []).map((s) => h(Select, { key: s.field, allowClear: true, showSearch: true, optionFilterProp: 'label', placeholder: s.placeholder, value: st.sel[s.field], options: selOptions(s), onChange: (v) => update({ sel: { [s.field]: v } }), style: { flex: '1 1 170px', minWidth: 150 } })),
    CFG.dateRange && h('span', { key: 'dr', style: { display: 'inline-flex', alignItems: 'center', gap: 6, flex: '1 1 300px' } },
      h('span', { style: { fontSize: 12, color: '#6b7280', whiteSpace: 'nowrap' } }, CFG.dateRange.label),
      h(DatePicker.RangePicker, { value: st.range, onChange: (v) => update({ range: v }), style: { flex: 1 } })),
    h(Space, { key: 'btns', wrap: true, style: { marginLeft: 'auto' } },
      h(Button, { onClick: clearAll }, 'Clear'),
      h(Upload, { accept: '.csv,text/csv', showUploadList: false, beforeUpload: importCSV }, h(Tooltip, { title: 'Headers must match the exported CSV' }, h(Button, { loading: busy }, 'Import CSV'))),
      h(Button, { onClick: exportCSV, loading: busy }, 'Export CSV')));

  // Announced politely when a tab or filter yields no records; the table below shows its own empty grid.
  let emptyNote = null;
  if (viewCount === 0) {
    const catLabel = (enumOpts('category').find((e) => e.value === activeTab.category) || {}).label || activeTab.label;
    if (hasOtherFilters(st)) emptyNote = [(activeTab.key === DEFAULT_TAB ? 'No appointments' : 'No ' + activeTab.label.toLowerCase()) + ' match these filters. ', h(Button, { key: 'clear', type: 'link', size: 'small', onClick: clearAll, style: { padding: 0 } }, 'Clear filters')];
    else if (activeTab.key === DEFAULT_TAB) emptyNote = 'No appointments yet. Use New appointment to book the first one.';
    else emptyNote = 'No ' + activeTab.label.toLowerCase() + ' yet. Set an appointment’s category to ' + catLabel + ' when you create or edit it.';
  }
  const emptyRegion = h('div', { key: 'empty', role: 'status', 'aria-live': 'polite', style: emptyNote ? { marginTop: 12, padding: '10px 14px', borderRadius: 8, background: '#fafafa', border: '1px dashed #d9d9d9', color: '#4b5563', fontSize: 13 } : undefined }, emptyNote);

  return h('div', { style: { background: '#fff', border: '1px solid #f0f0f0', borderRadius: 8, padding: 16 } }, tabsNav, kpiRow, filters, emptyRegion, h('a', { key: 'dl', ref: dlRef, style: { display: 'none' } }));
}
ctx.render(h(Toolbar));
