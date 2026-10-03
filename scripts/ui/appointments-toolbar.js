
const CFG = {"collection":"appointments","table":"yldxyya1moi","noun":"Appointments","search":{"fields":["customer.firstName","customer.lastName","staff.firstName","notes"],"placeholder":"Search customer, staff or notes"},"selects":[{"field":"category","placeholder":"All categories"},{"field":"status","placeholder":"All statuses"},{"field":"staffId","placeholder":"All staff","rel":{"collection":"staff","label":["firstName","lastName"]}}],"dateRange":{"field":"appointmentDate","label":"Date","dateOnly":true},"kpis":[{"label":"Scheduled","select":"status","value":"scheduled","color":"#2563eb"},{"label":"Confirmed","select":"status","value":"confirmed","color":"#0891b2"},{"label":"Completed","select":"status","value":"completed","color":"#16a34a"},{"label":"Cancelled","select":"status","value":"cancelled","color":"#dc2626"},{"label":"No show","select":"status","value":"noShow","color":"#ea580c"}],"columns":[{"key":"customer.firstName","label":"Customer","rel":{"collection":"customers","label":["firstName","lastName"]}},{"key":"staff.firstName","label":"Staff","rel":{"collection":"staff","label":["firstName","lastName"]}},{"key":"category","label":"Category"},{"key":"appointmentDate","label":"Date"},{"key":"startTime","label":"Start time"},{"key":"endTime","label":"End time"},{"key":"status","label":"Status"},{"key":"notes","label":"Notes"}]};
const React = ctx.React; const antd = ctx.antd; const dayjs = ctx.dayjs;
const { useState, useEffect, useRef, useMemo } = React;
const { Input, Select, DatePicker, Button, Space, Upload, message, Tooltip } = antd;
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
const req = async (url, params) => (await ctx.api.request({ url, params })).data;
const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);

function buildFilter(st, skipSelect) {
  const and = [];
  const q = (st.q || '').trim();
  if (q && CFG.search) and.push({ $or: CFG.search.fields.map((f) => ({ [f]: { $includes: q } })) });
  (CFG.selects || []).forEach((s) => {
    const v = st.sel[s.field];
    if (skipSelect && skipSelect === s.field) return;
    if (v !== undefined && v !== null && v !== '') and.push({ [s.field]: { $eq: v } });
  });
  if (CFG.dateRange && st.range && st.range[0] && st.range[1]) {
    const f = CFG.dateRange.field;
    if (CFG.dateRange.dateOnly) and.push({ [f]: { $gte: st.range[0].format('YYYY-MM-DD') } }, { [f]: { $lte: st.range[1].format('YYYY-MM-DD') } });
    else and.push({ [f]: { $gte: st.range[0].startOf('day').toISOString() } }, { [f]: { $lte: st.range[1].endOf('day').toISOString() } });
  }
  return and.length ? { $and: and } : {};
}
const merge = (a, b) => { const x = [a, b].filter((f) => f && Object.keys(f).length); return x.length ? { $and: x } : {}; };

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
  const [st, setSt] = useState({ q: '', sel: {}, range: null });
  const [counts, setCounts] = useState({});
  const [busy, setBusy] = useState(false);
  const timer = useRef(); const dlRef = useRef();

  useEffect(() => { (async () => {
    const coll = ctx.dataSourceManager.getDataSource('main').collectionManager.getCollection(CFG.collection); const c = { data: { fields: (coll ? coll.getFields() : []).map((f) => ({ name: f.name, interface: f.interface, enum: f.enum || (f.options && f.options.enum), uiSchema: f.uiSchema || (f.options && f.options.uiSchema) })) } };
    const fields = {}; (c.data.fields || []).forEach((f) => { fields[f.name] = f; });
    setMeta({ fields });
    const ro = {};
    for (const s of [...(CFG.selects || []), ...(CFG.columns || []).filter((c) => c.rel).map((c) => ({ rel: c.rel }))]) {
      if (!s.rel || ro[s.rel.collection]) continue;
      const r = await req(s.rel.collection + ':list', { paginate: false });
      ro[s.rel.collection] = (r.data || []).map((x) => ({ value: x.id, label: s.rel.label.map((k) => x[k]).filter(Boolean).join(' ') || String(x.id), raw: x }));
    }
    setRelOpts(ro);
  })().catch((e) => console.error(e)); }, []);

  const enumOpts = (field) => (meta.fields[field]?.enum || meta.fields[field]?.uiSchema?.enum || []).map((e) => ({ value: e.value, label: clean(e.label) }));
  const selOptions = (s) => s.rel ? (relOpts[s.rel.collection] || []).map(({ value, label }) => ({ value, label })) : s.options ? s.options.map(([value, label]) => ({ value, label })) : enumOpts(s.field);

  const refreshCounts = async (state) => {
    const base = buildFilter(state);
    const out = {};
    const r0 = await req(CFG.collection + ':list', { pageSize: 1, filter: base }); out.__view = r0.meta?.count ?? 0;
    for (const k of CFG.kpis || []) {
      const f = merge(buildFilter(state, k.select), { [k.select]: { $eq: k.value } });
      const r = await req(CFG.collection + ':list', { pageSize: 1, filter: f }); out[k.label] = r.meta?.count ?? 0;
    }
    setCounts(out);
  };

  const apply = async (state) => {
    const t = getTable(); const f = buildFilter(state);
    if (t?.resource) {
      if (Object.keys(f).length) t.resource.addFilterGroup(GROUP, f); else t.resource.removeFilterGroup(GROUP);
      t.resource.setPage(1); await t.resource.refresh();
    }
    refreshCounts(state).catch(() => {});
  };
  useEffect(() => { refreshCounts(st).catch(() => {}); }, []);

  const update = (patch, debounce) => {
    const next = { ...st, ...patch, sel: { ...st.sel, ...(patch.sel || {}) } };
    setSt(next);
    clearTimeout(timer.current);
    if (debounce) timer.current = setTimeout(() => apply(next), 350); else apply(next);
  };
  const clearAll = () => { const n = { q: '', sel: {}, range: null }; setSt(n); apply(n); };

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
      const t = getTable(); if (t?.resource) await t.resource.refresh();
      refreshCounts(st).catch(() => {});
      if (errs.length) antd.Modal.warning({ title: 'Imported ' + ok + ' of ' + (rows.length - 1) + ' rows', width: 560, content: h('div', { style: { maxHeight: 300, overflow: 'auto', whiteSpace: 'pre-wrap', fontSize: 12 } }, errs.join('\n')) });
      else message.success('Imported ' + ok + ' rows');
    } catch (e) { message.error('Import failed: ' + (e?.message || e)); } finally { setBusy(false); }
    return false;
  };

  const tile = (label, value, color, active, onClick) => h('div', { key: label, onClick, style: { flex: '1 1 100px', minWidth: 96, border: '1px solid ' + (active ? '#94a3b8' : '#e5e7eb'), background: active ? '#f5f5f5' : '#fff', borderRadius: 8, padding: '10px 14px', cursor: onClick ? 'pointer' : 'default' } },
    h('div', { style: { fontSize: 12, color: '#6b7280' } }, label),
    h('div', { style: { fontSize: 20, fontWeight: 600, color: color || '#111827', marginTop: 2 } }, value ?? '–'));

  const kpiRow = h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', paddingBottom: 14, borderBottom: '1px solid #f0f0f0', marginBottom: 14 } },
    tile((CFG.noun || 'Records') + ' in view', counts.__view, null, !Object.values(st.sel).some((v) => v !== undefined && v !== null), () => update({ sel: Object.fromEntries((CFG.kpis || []).map((k) => [k.select, undefined])) })),
    ...(CFG.kpis || []).map((k) => tile(k.label, counts[k.label], k.color, st.sel[k.select] === k.value, () => update({ sel: { [k.select]: st.sel[k.select] === k.value ? undefined : k.value } }))));

  const filters = h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' } },
    CFG.search && h(Input, { key: 'q', allowClear: true, placeholder: CFG.search.placeholder || 'Search', value: st.q, onChange: (e) => update({ q: e.target.value }, true), style: { flex: '2 1 240px', minWidth: 200 }, prefix: h('span', { style: { color: '#9ca3af' } }, '⌕') }),
    ...(CFG.selects || []).map((s) => h(Select, { key: s.field, allowClear: true, showSearch: true, optionFilterProp: 'label', placeholder: s.placeholder, value: st.sel[s.field], options: selOptions(s), onChange: (v) => update({ sel: { [s.field]: v } }), style: { flex: '1 1 170px', minWidth: 150 } })),
    CFG.dateRange && h('span', { key: 'dr', style: { display: 'inline-flex', alignItems: 'center', gap: 6, flex: '1 1 300px' } },
      h('span', { style: { fontSize: 12, color: '#6b7280', whiteSpace: 'nowrap' } }, CFG.dateRange.label),
      h(DatePicker.RangePicker, { value: st.range, onChange: (v) => update({ range: v }), style: { flex: 1 } })),
    h(Space, { key: 'btns', wrap: true, style: { marginLeft: 'auto' } },
      h(Button, { onClick: clearAll }, 'Clear'),
      h(Upload, { accept: '.csv,text/csv', showUploadList: false, beforeUpload: importCSV }, h(Tooltip, { title: 'Headers must match the exported CSV' }, h(Button, { loading: busy }, 'Import CSV'))),
      h(Button, { onClick: exportCSV, loading: busy }, 'Export CSV')));

  return h('div', { style: { background: '#fff', border: '1px solid #f0f0f0', borderRadius: 8, padding: 16 } }, kpiRow, filters, h('a', { ref: dlRef, style: { display: 'none' } }));
}
ctx.render(h(Toolbar));
