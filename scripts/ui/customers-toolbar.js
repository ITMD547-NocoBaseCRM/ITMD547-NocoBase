// Customers page toolbar (JS block): search, customer activity filters, sort, status / birthday / customer-since
// filters, KPI tiles and CSV import/export. It drives the native customers table on the same page, so every list
// request goes through the server with the signed-in role's permissions; nothing is filtered in the browser.
//
// Activity filters (inactive for N months, most active, new, one-time, repeat, high-value, at risk, never visited)
// use the activity columns on customers (visitCount, firstVisitAt, lastVisitAt, totalSpent, visitsLastNm), which are
// kept up to date from completed appointments and payments. Their definitions are injected below from
// scripts/customer-activity-rules.js so the toolbar, the tests and the documentation share one source.
const CFG = {"collection":"customers","table":"","noun":"Customers","search":{"fields":["firstName","lastName","email","phone"],"placeholder":"Search customer name, email or phone"},"selects":[{"field":"status","placeholder":"All statuses"}],"dateRange":{"field":"createdAt","label":"Customer since"},"kpis":[{"label":"Active","select":"status","value":"active","color":"#16a34a"},{"label":"Prospect","select":"status","value":"prospect","color":"#2563eb"},{"label":"Inactive","select":"status","value":"inactive","color":"#ea580c"},{"label":"Blocked","select":"status","value":"blocked","color":"#dc2626"}],"activityKpis":[{"label":"Never visited","activity":"never","color":"#6b7280"},{"label":"Inactive","activity":"inactive","color":"#ea580c"},{"label":"At risk","activity":"atRisk","color":"#dc2626"},{"label":"New","activity":"new","color":"#16a34a"}],"columns":[{"key":"firstName","label":"First name"},{"key":"lastName","label":"Last name"},{"key":"email","label":"Email"},{"key":"phone","label":"Phone"},{"key":"dateOfBirth","label":"Date of birth"},{"key":"address","label":"Address"},{"key":"status","label":"Status"},{"key":"notes","label":"Notes"},{"key":"createdAt","label":"Customer since","readOnly":true},{"key":"visitCount","label":"Completed visits","readOnly":true},{"key":"lastVisitAt","label":"Last visit","readOnly":true,"format":"datetime"},{"key":"firstVisitAt","label":"First visit","readOnly":true,"format":"datetime"},{"key":"totalSpent","label":"Total spent","readOnly":true}]};
/*CUSTOMER_ACTIVITY_RULES*/
let CAN_IMPORT = true;
try {
  const __acl = ctx.acl;
  if (__acl && typeof __acl.aclCheck === 'function') {
    const __ok = await __acl.aclCheck({ dataSourceKey: 'main', resourceName: CFG.collection, actionName: 'create' });
    CAN_IMPORT = !!__ok;
  }
} catch (e) { CAN_IMPORT = true; }

const React = ctx.React; const antd = ctx.antd; const dayjs = ctx.dayjs;
const { useState, useEffect, useRef } = React;
const { Input, Select, DatePicker, Button, Space, Upload, message, Tooltip, Modal, Radio, Checkbox, Alert, Tag } = antd;
const h = React.createElement;
const clean = (s) => String(s ?? '').replace(/^\{\{\s*t\(\s*["'](.*)["']\s*\)\s*\}\}$/, '$1');
// Resolve the customers table on this page dynamically so the toolbar survives block uid changes. CFG.table is a last resort.
const isCustomersTable = (m) => {
  if (!m || m === ctx.model) return false;
  const init = typeof m.getStepParams === 'function' ? m.getStepParams('resourceSettings', 'init') : null;
  const coll = (init && init.collectionName) || (m.collection && m.collection.name);
  return coll === CFG.collection && !!m.resource;
};
const getTable = () => {
  const siblings = (ctx.model && ctx.model.parent && ctx.model.parent.subModels && ctx.model.parent.subModels.items) || [];
  return siblings.find(isCustomersTable) || (CFG.table ? ctx.engine.getModel(CFG.table) : null);
};
const whenTableReady = async () => {
  for (let i = 0; i < 50; i++) {
    const t = getTable();
    if (t && t.resource && !t.resource.loading) return t;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return getTable();
};
const GROUP = 'toolbar-customers';
const req = async (url, params) => (await ctx.api.request({ url, params })).data;
const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
const errText = (e) => (e && e.response && e.response.data && e.response.data.errors && e.response.data.errors[0] && e.response.data.errors[0].message) || (e && e.message) || String(e);

const DEFAULT_MONTHS = 3;
const initialState = () => ({ q: '', sel: {}, range: null, bday: undefined, activity: 'all', months: DEFAULT_MONTHS, sort: CUSTOMER_ACTIVITY.defaultSort('all') });

const BDAY_OPTS = [
  { value: 'today', label: 'Birthday today' },
  { value: '7', label: 'Birthdays in next 7 days' },
  { value: '30', label: 'Birthdays in next 30 days' },
  { value: 'month', label: 'Birthdays this month' },
  { value: 'all', label: 'All, by upcoming birthday' },
];
const mmdd = (d) => (d.getMonth() + 1) * 100 + d.getDate();
function bdayFilter(v) {
  if (!v) return null;
  const now = new Date(); const start = mmdd(now);
  if (v === 'all') return {};
  if (v === 'today') return { birthMonthDay: { $eq: start } };
  if (v === 'month') { const m = (now.getMonth() + 1) * 100; return { $and: [{ birthMonthDay: { $gte: m + 1 } }, { birthMonthDay: { $lte: m + 31 } }] }; }
  const end = mmdd(new Date(now.getFullYear(), now.getMonth(), now.getDate() + Number(v)));
  return end >= start ? { $and: [{ birthMonthDay: { $gte: start } }, { birthMonthDay: { $lte: end } }] }
    : { $or: [{ birthMonthDay: { $gte: start } }, { birthMonthDay: { $lte: end } }] };
}

// opts.skipSelect: leave one status out (for that status's KPI count). opts.skipActivity: leave the activity rule out
// (for the activity KPI counts, which each apply their own rule on top of the other filters).
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
    and.push({ [f]: { $gte: st.range[0].startOf('day').toISOString() } }, { [f]: { $lte: st.range[1].endOf('day').toISOString() } });
  }
  const bf = bdayFilter(st.bday); if (bf && Object.keys(bf).length) and.push(bf);
  if (!opts.skipActivity) {
    const af = CUSTOMER_ACTIVITY.filter({ activity: st.activity, months: st.months, now: new Date() });
    if (af && Object.keys(af).length) and.push(af);
  }
  return and.length ? { $and: and } : {};
}
const merge = (a, b) => { const x = [a, b].filter((f) => f && Object.keys(f).length); return x.length ? { $and: x } : {}; };
const buildSort = (st) => (st.bday ? ['birthMonthDay', 'firstName'] : CUSTOMER_ACTIVITY.sort({ sort: st.sort, months: st.months }));
const hasOtherFilters = (st) => !!((st.q || '').trim() || Object.values(st.sel).some((v) => v !== undefined && v !== null && v !== '') || (st.range && st.range[0] && st.range[1]) || st.bday);

// ---- Send message (SMS / email) -------------------------------------------------------------------------------
// Each recipient and channel becomes one row in the customerMessages outbox (status "queued"); the workflow
// "Deliver customer messages" sends it. See docs/customer-activity-filters.md, section "Sending messages".
const MSG = /*CUSTOMER_MESSAGING*/{"collection":"customerMessages","emailChannel":"customer-email","pageTitle":"Customer messages"};
const CHANNEL_OPTS = [{ value: 'sms', label: 'SMS' }, { value: 'email', label: 'Email' }];
const renderTemplate = (template, customer) => {
  const values = { firstName: customer.firstName || '', lastName: customer.lastName || '', fullName: [customer.firstName, customer.lastName].filter(Boolean).join(' ') };
  return String(template || '').replace(/\{\{\s*(firstName|lastName|fullName)\s*\}\}/g, (_, key) => values[key]);
};
const SMS_LIMIT = 320;
const EMAIL_WRAP = (inner) => '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#111827;max-width:640px">' + inner + '</div>';
const escapeHtml = (s) => String(s || '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
const textToHtml = (s) => '<p>' + escapeHtml(s).replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br/>') + '</p>';

// Rich text editor for emails: a contentEditable area with a small toolbar (bold, italic, underline, heading, lists,
// link, image, clear). Images are uploaded to NocoBase file storage (attachments) and inlined by absolute URL, so
// mail clients can fetch them. Reports both HTML and plain text (the plain text is what SMS uses).
function RichEditor({ html, onChange, placeholder }) {
  const ref = useRef();
  const fileRef = useRef();
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const [uploading, setUploading] = useState(false);
  const savedRange = useRef(null);
  useEffect(() => { if (ref.current && ref.current.innerHTML !== (html || '')) ref.current.innerHTML = html || ''; }, []);
  const emit = () => { const el = ref.current; if (el) onChange({ html: el.innerHTML, text: el.innerText || '' }); };
  const doc = () => ref.current.ownerDocument;
  const exec = (cmd, arg) => { ref.current.focus(); doc().execCommand(cmd, false, arg); emit(); };
  const saveRange = () => { const sel = doc().getSelection(); if (sel && sel.rangeCount) savedRange.current = sel.getRangeAt(0); };
  const restoreRange = () => { const sel = doc().getSelection(); if (savedRange.current && sel) { sel.removeAllRanges(); sel.addRange(savedRange.current); } };
  const insertImage = async (file) => {
    if (!file) return;
    setUploading(true);
    try {
      const form = new window.FormData(); form.append('file', file);
      const r = await ctx.api.request({ url: 'attachments:create', method: 'post', data: form, headers: { 'Content-Type': 'multipart/form-data' } });
      const rec = (r.data && r.data.data) || {};
      const url = rec.url || ((rec.storage && rec.storage.baseUrl) || '') + (rec.path || '') + '/' + (rec.filename || '');
      const abs = /^https?:\/\//.test(url) ? url : window.location.origin + (url.startsWith('/') ? url : '/' + url);
      ref.current.focus(); restoreRange();
      doc().execCommand('insertHTML', false, '<img src="' + abs + '" alt="' + escapeHtml(file.name) + '" style="max-width:100%;height:auto;display:block;margin:8px 0" />');
      emit();
    } catch (e) { message.error('Image upload failed: ' + errText(e)); } finally { setUploading(false); }
  };
  const applyLink = () => { const url = linkUrl.trim(); setLinkOpen(false); if (!url) return; ref.current.focus(); restoreRange(); doc().execCommand('createLink', false, /^https?:\/\//.test(url) ? url : 'https://' + url); emit(); setLinkUrl(''); };
  const tb = (label, title, onClick, extra = {}) => h(Button, { key: title, size: 'small', title, 'aria-label': title, onMouseDown: (e) => e.preventDefault(), onClick, ...extra }, label);
  const toolbar = h('div', { style: { display: 'flex', gap: 4, flexWrap: 'wrap', padding: 6, borderBottom: '1px solid #e5e7eb', background: '#fafafa', borderRadius: '6px 6px 0 0' } },
    tb(h('b', null, 'B'), 'Bold', () => exec('bold')),
    tb(h('i', null, 'I'), 'Italic', () => exec('italic')),
    tb(h('u', null, 'U'), 'Underline', () => exec('underline')),
    tb('H2', 'Heading', () => exec('formatBlock', '<h2>')),
    tb('¶', 'Paragraph', () => exec('formatBlock', '<p>')),
    tb('• List', 'Bullet list', () => exec('insertUnorderedList')),
    tb('1. List', 'Numbered list', () => exec('insertOrderedList')),
    tb('Link', 'Insert link', () => { saveRange(); setLinkOpen(true); }),
    tb(uploading ? 'Uploading…' : 'Image', 'Insert image', () => { saveRange(); fileRef.current && fileRef.current.click(); }, { loading: uploading }),
    tb('Clear', 'Remove formatting', () => exec('removeFormat')),
    h('input', { key: 'file', ref: fileRef, type: 'file', accept: 'image/*', style: { display: 'none' }, onChange: (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; insertImage(f); } }),
    linkOpen && h('span', { key: 'link', style: { display: 'inline-flex', gap: 4, alignItems: 'center', marginLeft: 6 } },
      h(Input, { size: 'small', autoFocus: true, placeholder: 'https://', value: linkUrl, onChange: (e) => setLinkUrl(e.target.value), onPressEnter: applyLink, style: { width: 220 } }),
      h(Button, { size: 'small', type: 'primary', onClick: applyLink }, 'Add'),
      h(Button, { size: 'small', onClick: () => setLinkOpen(false) }, 'Cancel')));
  return h('div', { style: { border: '1px solid #d9d9d9', borderRadius: 6 } }, toolbar,
    h('div', { ref, contentEditable: true, suppressContentEditableWarning: true, role: 'textbox', 'aria-multiline': true, 'aria-label': 'Email message', 'data-placeholder': placeholder,
      onInput: emit, onBlur: emit, onKeyUp: saveRange, onMouseUp: saveRange,
      style: { minHeight: 180, maxHeight: 360, overflow: 'auto', padding: '10px 12px', outline: 'none', fontSize: 14, lineHeight: 1.5 } }),
    h('style', null, '[data-placeholder]:empty:before{content:attr(data-placeholder);color:#9ca3af}'));
}
// Phones are stored as typed ("312-555-9001"); SMS providers need E.164 ("+13125559001"). US numbers by default.
const DEFAULT_COUNTRY_CODE = '1';
const toE164 = (raw) => {
  const s = String(raw || '').trim();
  const digits = s.replace(/\D/g, '');
  if (!digits) return null;
  if (s.startsWith('+') && digits.length >= 8 && digits.length <= 15) return '+' + digits;
  if (digits.length === 10) return '+' + DEFAULT_COUNTRY_CODE + digits;
  if (digits.length === 11 && digits.startsWith(DEFAULT_COUNTRY_CODE)) return '+' + digits;
  return null;
};

function SendMessageDialog({ open, onClose, selected, viewFilter, viewCount }) {
  const [audience, setAudience] = useState(selected.length ? 'selected' : 'view');
  const [channels, setChannels] = useState(['sms', 'email']);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');        // plain text: SMS, and the text column of the outbox
  const [bodyHtml, setBodyHtml] = useState(''); // rich HTML: email
  const [recipients, setRecipients] = useState(null);
  const [sending, setSending] = useState(false);
  const [emailChannelOk, setEmailChannelOk] = useState(null);

  useEffect(() => { if (open) { setAudience(selected.length ? 'selected' : 'view'); setRecipients(null); } }, [open]);
  // Load the recipients' contact details (only id, names, email, phone) for the chosen audience.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const params = { paginate: false, fields: ['id', 'firstName', 'lastName', 'email', 'phone'] };
        if (audience === 'selected') params.filter = { id: { $in: selected.map((r) => r.id) } }; else if (Object.keys(viewFilter).length) params.filter = viewFilter;
        const r = await req(CFG.collection + ':list', params);
        if (!cancelled) setRecipients(r.data || []);
      } catch (e) { if (!cancelled) { setRecipients([]); message.error('Could not load recipients: ' + errText(e)); } }
    })();
    return () => { cancelled = true; };
  }, [open, audience, selected, viewFilter]);
  // Whether the email notification channel exists (admins only; others simply do not get the hint).
  useEffect(() => {
    if (!open || emailChannelOk !== null) return;
    (async () => {
      try { const r = await req('notificationChannels:list', { paginate: false, filter: { notificationType: 'email' } }); setEmailChannelOk((r.data || []).length > 0); }
      catch (e) { setEmailChannelOk(undefined); }
    })();
  }, [open]);

  const list = recipients || [];
  const withEmail = list.filter((c) => c.email && /\S+@\S+/.test(c.email));
  const withPhone = list.filter((c) => !!toE164(c.phone));
  const wantsSms = channels.includes('sms'); const wantsEmail = channels.includes('email');
  const plannedSms = wantsSms ? withPhone.length : 0; const plannedEmail = wantsEmail ? withEmail.length : 0;
  const unreachable = list.filter((c) => !(wantsSms && withPhone.includes(c)) && !(wantsEmail && withEmail.includes(c)));
  const total = plannedSms + plannedEmail;
  const smsTooLong = wantsSms && body.length > SMS_LIMIT;
  const hasContent = body.trim() || /<img\b/i.test(bodyHtml);
  const canSend = !sending && total > 0 && hasContent && (!wantsEmail || subject.trim()) && !smsTooLong && (!wantsSms || body.trim());
  // Email content: the editor's HTML when the editor was used, else the plain text as paragraphs.
  const emailHtml = (c) => EMAIL_WRAP(renderTemplate(bodyHtml && bodyHtml.replace(/<[^>]+>/g, '').trim() === '' && !/<img\b/i.test(bodyHtml) ? textToHtml(body) : (bodyHtml || textToHtml(body)), c));

  const send = async () => {
    setSending(true);
    const batchKey = 'msg-' + dayjs().format('YYYYMMDD-HHmmss') + '-' + Math.random().toString(36).slice(2, 7);
    const jobs = [];
    for (const c of list) {
      const rendered = renderTemplate(body, c); const renderedSubject = renderTemplate(subject, c);
      if (wantsSms && withPhone.includes(c)) jobs.push({ customer: { id: c.id }, channel: 'sms', recipient: toE164(c.phone), subject: null, body: rendered, status: 'queued', batchKey });
      if (wantsEmail && withEmail.includes(c)) jobs.push({ customer: { id: c.id }, channel: 'email', recipient: c.email.trim(), subject: renderedSubject, body: rendered, bodyHtml: emailHtml(c), status: 'queued', batchKey });
    }
    let ok = 0; const errs = [];
    for (let i = 0; i < jobs.length; i += 5) {
      await Promise.all(jobs.slice(i, i + 5).map((data) => ctx.api.request({ url: MSG.collection + ':create', method: 'post', data }).then(() => { ok++; }).catch((e) => errs.push(errText(e)))));
    }
    setSending(false);
    if (errs.length) Modal.warning({ title: 'Queued ' + ok + ' of ' + jobs.length + ' messages', content: h('div', { style: { whiteSpace: 'pre-wrap', maxHeight: 240, overflow: 'auto', fontSize: 12 } }, [...new Set(errs)].join('\n')) });
    else message.success('Queued ' + ok + ' message' + (ok === 1 ? '' : 's') + ' for delivery. Progress is in ' + MSG.pageTitle + '.');
    if (ok) { setBody(''); setBodyHtml(''); setSubject(''); onClose(); }
  };

  const stat = (label, value) => h('span', { key: label, style: { marginRight: 14 } }, h('strong', null, value), ' ', label);
  return h(Modal, {
    open, title: 'Send message to customers', onCancel: onClose, width: 640, destroyOnClose: true,
    footer: [h(Button, { key: 'cancel', onClick: onClose }, 'Cancel'), h(Button, { key: 'send', type: 'primary', loading: sending, disabled: !canSend, onClick: send }, 'Send ' + (total ? total + ' message' + (total === 1 ? '' : 's') : ''))],
  },
  h('div', { style: { display: 'flex', flexDirection: 'column', gap: 14 } },
    h('div', null, h('div', { style: { fontWeight: 600, marginBottom: 6 } }, 'Recipients'),
      h(Radio.Group, { value: audience, onChange: (e) => setAudience(e.target.value) },
        h(Radio, { value: 'selected', disabled: !selected.length }, 'Selected rows (' + selected.length + ')'),
        h(Radio, { value: 'view' }, 'All customers in the current view (' + (viewCount ?? '…') + ')')),
      h('div', { style: { marginTop: 8, fontSize: 13, color: '#4b5563' } },
        recipients === null ? 'Loading recipients…' : [stat('customers', list.length), stat('with phone', withPhone.length), stat('with email', withEmail.length)]),
      unreachable.length > 0 && recipients !== null && h('div', { style: { marginTop: 4, fontSize: 12, color: '#b45309' } },
        unreachable.length + ' customer' + (unreachable.length === 1 ? ' has' : 's have') + ' no usable contact for the chosen channel' + (channels.length > 1 ? 's' : '') + ' and will be skipped: ' + unreachable.slice(0, 5).map((c) => [c.firstName, c.lastName].filter(Boolean).join(' ')).join(', ') + (unreachable.length > 5 ? ', …' : ''))),
    h('div', null, h('div', { style: { fontWeight: 600, marginBottom: 6 } }, 'Send by'),
      h(Checkbox.Group, { options: CHANNEL_OPTS, value: channels, onChange: setChannels }),
      wantsEmail && emailChannelOk === false && h(Alert, { type: 'warning', showIcon: true, style: { marginTop: 8 }, message: 'Email delivery is not configured yet', description: 'Create an Email notification channel (Settings → Notification management → Channels) with the salon SMTP details, then run yarn apply:customer-messaging so the delivery workflow uses it.' })),
    wantsEmail && h('div', null, h('div', { style: { fontWeight: 600, marginBottom: 6 } }, 'Subject (email)'),
      h(Input, { value: subject, maxLength: 150, onChange: (e) => setSubject(e.target.value), placeholder: 'We miss you, {{firstName}}!' })),
    h('div', null, h('div', { style: { fontWeight: 600, marginBottom: 6 } }, wantsEmail ? 'Message' + (wantsSms ? ' (the SMS gets the plain text)' : '') : 'Message'),
      wantsEmail
        ? h(RichEditor, { html: bodyHtml, onChange: ({ html: nextHtml, text }) => { setBodyHtml(nextHtml); setBody(text.replace(/ /g, ' ').trim()); }, placeholder: 'Hi {{firstName}}, it has been a while since your last visit. Book this month and enjoy 15% off.' })
        : h(Input.TextArea, { value: body, rows: 5, onChange: (e) => { setBody(e.target.value); setBodyHtml(''); }, placeholder: 'Hi {{firstName}}, it has been a while since your last visit. Book this month and enjoy 15% off.' }),
      h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: 12, color: smsTooLong ? '#dc2626' : '#6b7280', marginTop: 4 } },
        h('span', null, 'Placeholders: ', h(Tag, null, '{{firstName}}'), h(Tag, null, '{{lastName}}'), h(Tag, null, '{{fullName}}')),
        h('span', null, body.length + (wantsSms ? ' / ' + SMS_LIMIT + ' characters (SMS)' : ' characters')))),
    list.length > 0 && hasContent && h('div', { style: { background: '#fafafa', border: '1px dashed #d9d9d9', borderRadius: 8, padding: '8px 12px', fontSize: 13 } },
      h('div', { style: { fontSize: 12, color: '#6b7280', marginBottom: 4 } }, 'Preview for ' + [list[0].firstName, list[0].lastName].filter(Boolean).join(' ')),
      wantsEmail && subject.trim() && h('div', { style: { fontWeight: 600 } }, renderTemplate(subject, list[0])),
      wantsEmail
        ? h('div', { style: { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 6, padding: '8px 12px' }, dangerouslySetInnerHTML: { __html: emailHtml(list[0]) } })
        : h('div', { style: { whiteSpace: 'pre-wrap' } }, renderTemplate(body, list[0])),
      wantsSms && wantsEmail && h('div', { style: { marginTop: 6, fontSize: 12, color: '#6b7280' } }, 'SMS text: ', renderTemplate(body, list[0])))));
}

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
  const [st, setSt] = useState(initialState);
  const [counts, setCounts] = useState({});
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [msgOpen, setMsgOpen] = useState(false);
  const [msgSelected, setMsgSelected] = useState([]);
  const timer = useRef(); const countTimer = useRef(); const dlRef = useRef();
  const stRef = useRef(st); stRef.current = st;
  const countSeq = useRef(0);     // drops count responses that arrive after a newer request
  const selfRefresh = useRef(0);  // table refreshes started by this toolbar (not CRUD)
  const lastPage = useRef(1);

  useEffect(() => {
    try {
      const coll = ctx.dataSourceManager.getDataSource('main').collectionManager.getCollection(CFG.collection);
      const fields = {};
      (coll ? coll.getFields() : []).forEach((f) => { fields[f.name] = { name: f.name, interface: f.interface, enum: f.enum || (f.options && f.options.enum), uiSchema: f.uiSchema || (f.options && f.options.uiSchema) }; });
      setMeta({ fields });
    } catch (e) { console.error(e); }
  }, []);

  const enumOpts = (field) => (meta.fields[field]?.enum || meta.fields[field]?.uiSchema?.enum || []).map((e) => ({ value: e.value, label: clean(e.label) }));
  const selOptions = (s) => s.options ? s.options.map(([value, label]) => ({ value, label })) : enumOpts(s.field);

  // Counts are one-row list requests (meta.count only), filtered on the server.
  const refreshCounts = async (state) => {
    const seq = ++countSeq.current;
    const out = {};
    const jobs = [req(CFG.collection + ':list', { pageSize: 1, filter: buildFilter(state) }).then((r) => { out.__view = r.meta?.count ?? 0; })];
    (CFG.kpis || []).forEach((k) => {
      const f = merge(buildFilter(state, { skipSelect: k.select }), { [k.select]: { $eq: k.value } });
      jobs.push(req(CFG.collection + ':list', { pageSize: 1, filter: f }).then((r) => { out[k.label] = r.meta?.count ?? 0; }));
    });
    (CFG.activityKpis || []).forEach((k) => {
      const f = merge(buildFilter(state, { skipActivity: true }), CUSTOMER_ACTIVITY.filter({ activity: k.activity, months: state.months, now: new Date() }));
      jobs.push(req(CFG.collection + ':list', { pageSize: 1, filter: f }).then((r) => { out['activity:' + k.activity] = r.meta?.count ?? 0; }));
    });
    await Promise.all(jobs);
    if (seq !== countSeq.current) return;
    setCounts(out);
  };
  const scheduleCounts = () => {
    clearTimeout(countTimer.current);
    countTimer.current = setTimeout(() => refreshCounts(stRef.current).catch(() => {}), 200);
  };

  const apply = async (state) => {
    const t = getTable(); const f = buildFilter(state);
    if (t?.resource) {
      if (Object.keys(f).length) t.resource.addFilterGroup(GROUP, f); else t.resource.removeFilterGroup(GROUP);
      if (typeof t.resource.setSort === 'function') t.resource.setSort(buildSort(state));
      t.resource.setPage(1);
      selfRefresh.current += 1;
      try { await t.resource.refresh(); setLoadError(null); }
      catch (e) { setLoadError('Could not load customers: ' + errText(e)); }
      finally { selfRefresh.current -= 1; lastPage.current = typeof t.resource.getPage === 'function' ? t.resource.getPage() : 1; }
    }
    refreshCounts(state).catch((e) => setLoadError('Could not count customers: ' + errText(e)));
  };

  useEffect(() => {
    let cancelled = false; let off = null;
    refreshCounts(stRef.current).catch(() => {});
    (async () => {
      const t = await whenTableReady();
      if (cancelled || !t || !t.resource || typeof t.resource.on !== 'function') return;
      lastPage.current = typeof t.resource.getPage === 'function' ? t.resource.getPage() : 1;
      // A refresh the toolbar did not start means a record was created, edited or deleted: counts may have changed.
      const onRefresh = () => {
        const page = typeof t.resource.getPage === 'function' ? t.resource.getPage() : 1;
        const paged = page !== lastPage.current; lastPage.current = page;
        if (selfRefresh.current > 0 || paged) return;
        scheduleCounts();
      };
      t.resource.on('refresh', onRefresh);
      off = () => t.resource.off('refresh', onRefresh);
    })().catch((e) => console.error(e));
    return () => { cancelled = true; clearTimeout(countTimer.current); clearTimeout(timer.current); if (off) off(); };
  }, []);

  const update = (patch, debounce) => {
    const next = { ...st, ...patch, sel: { ...st.sel, ...(patch.sel || {}) } };
    // Choosing an activity also picks the sort that makes it readable (most inactive -> longest since last visit, ...).
    if ('activity' in patch && patch.activity !== st.activity && !('sort' in patch)) next.sort = CUSTOMER_ACTIVITY.defaultSort(next.activity);
    setSt(next); stRef.current = next;
    clearTimeout(timer.current);
    if (debounce) timer.current = setTimeout(() => apply(next), 350); else apply(next);
  };
  const clearAll = () => { const n = initialState(); setSt(n); stRef.current = n; apply(n); };

  const fmt = (col, v) => {
    if (v == null) return '';
    if (col.format === 'datetime') return dayjs(v).format('YYYY-MM-DD HH:mm');
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
      const r = await req(CFG.collection + ':list', { paginate: false, filter: buildFilter(st), appends, sort: buildSort(st) });
      const rows = r.data || [];
      const lines = [CFG.columns.map((c) => csvCell(c.label)).join(',')];
      rows.forEach((row) => lines.push(CFG.columns.map((c) => csvCell(fmt(c, getPath(row, c.key)))).join(',')));
      const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = dlRef.current; a.href = url; a.download = CFG.collection + '-' + dayjs().format('YYYY-MM-DD') + '.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 2000);
      message.success('Exported ' + rows.length + ' rows');
    } catch (e) { message.error('Export failed: ' + errText(e)); } finally { setBusy(false); }
  };

  const toValue = (col, raw) => {
    const s = String(raw ?? '').trim(); if (s === '') return undefined;
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
      const cols = header.map((hd) => CFG.columns.find((c) => !c.readOnly && (c.label.toLowerCase() === hd || c.key.toLowerCase() === hd)) || null);
      if (!cols.some(Boolean)) { message.error('No CSV columns match this table. Export a CSV first to see the expected headers.'); return false; }
      let ok = 0; const errs = [];
      for (let i = 1; i < rows.length; i++) {
        try {
          const values = {};
          cols.forEach((c, j) => { if (!c) return; const v = toValue(c, rows[i][j]); if (v !== undefined) values[c.key] = v; });
          await ctx.api.request({ url: CFG.collection + ':create', method: 'post', data: values });
          ok++;
        } catch (e) { errs.push('Row ' + (i + 1) + ': ' + errText(e)); }
      }
      // The table refresh below also refreshes the counts (see the refresh listener).
      const t = getTable(); if (t?.resource) await t.resource.refresh(); else scheduleCounts();
      if (errs.length) antd.Modal.warning({ title: 'Imported ' + ok + ' of ' + (rows.length - 1) + ' rows', width: 560, content: h('div', { style: { maxHeight: 300, overflow: 'auto', whiteSpace: 'pre-wrap', fontSize: 12 } }, errs.join('\n')) });
      else message.success('Imported ' + ok + ' rows');
    } catch (e) { message.error('Import failed: ' + errText(e)); } finally { setBusy(false); }
    return false;
  };

  const tile = (label, value, color, active, onClick) => h('div', { key: label, role: 'button', tabIndex: 0, 'aria-pressed': !!active, onClick, onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }, style: { flex: '1 1 100px', minWidth: 96, border: '1px solid ' + (active ? '#94a3b8' : '#e5e7eb'), background: active ? '#f5f5f5' : '#fff', borderRadius: 8, padding: '10px 14px', cursor: 'pointer' } },
    h('div', { style: { fontSize: 12, color: '#6b7280' } }, label),
    h('div', { style: { fontSize: 20, fontWeight: 600, color: color || '#111827', marginTop: 2 } }, value ?? '–'));

  const activityLabel = (key) => CUSTOMER_ACTIVITY.byKey(key).label(st.months);
  const kpiRow = h('div', { key: 'kpis', style: { display: 'flex', gap: 10, flexWrap: 'wrap', paddingBottom: 14, borderBottom: '1px solid #f0f0f0', marginBottom: 14 } },
    tile((CFG.noun || 'Records') + ' in view', counts.__view, null, st.activity === 'all' && !Object.values(st.sel).some((v) => v !== undefined && v !== null), () => update({ activity: 'all', sel: Object.fromEntries((CFG.kpis || []).map((k) => [k.select, undefined])) })),
    ...(CFG.kpis || []).map((k) => tile(k.label, counts[k.label], k.color, st.sel[k.select] === k.value, () => update({ sel: { [k.select]: st.sel[k.select] === k.value ? undefined : k.value } }))),
    ...(CFG.activityKpis || []).map((k) => tile(CUSTOMER_ACTIVITY.byKey(k.activity).period ? activityLabel(k.activity) : k.label, counts['activity:' + k.activity], k.color, st.activity === k.activity, () => update({ activity: st.activity === k.activity ? 'all' : k.activity }))));

  // Every control sits in a labelled cell of the same height, so the two rows line up whatever the screen width.
  // `flex` is "grow shrink basis": basis is the preferred width, cells wrap to the next line on narrow screens.
  const cell = (text, control, flex, extra = {}) => h('div', { key: text, style: { display: 'flex', flexDirection: 'column', gap: 4, flex, minWidth: 0, ...extra } },
    h('div', { style: { fontSize: 12, fontWeight: 600, color: '#374151', lineHeight: '18px', whiteSpace: 'nowrap' } }, text), control);
  const row = (key, children) => h('div', { key, style: { display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 12 } }, ...children);
  const full = { width: '100%' };
  const periodEnabled = CUSTOMER_ACTIVITY.usesPeriod(st.activity, st.sort);

  const generalRow = row('general', [
    CFG.search && cell('Search', h(Input, { allowClear: true, placeholder: CFG.search.placeholder || 'Search', value: st.q, onChange: (e) => update({ q: e.target.value }, true), style: full, prefix: h('span', { style: { color: '#9ca3af' } }, '⌕'), 'aria-label': 'Search customers' }), '3 1 260px'),
    ...(CFG.selects || []).map((s) => cell(s.label || 'Status', h(Select, { allowClear: true, showSearch: true, optionFilterProp: 'label', placeholder: s.placeholder, value: st.sel[s.field], options: selOptions(s), onChange: (v) => update({ sel: { [s.field]: v } }), style: full }), '1 1 150px')),
    cell('Birthday', h(Select, { allowClear: true, placeholder: 'Any', value: st.bday, options: BDAY_OPTS, onChange: (v) => update({ bday: v }), style: full }), '1 1 190px'),
    CFG.dateRange && cell(CFG.dateRange.label, h(DatePicker.RangePicker, { value: st.range, onChange: (v) => update({ range: v }), style: full }), '2 1 260px'),
  ]);

  const activityRow = row('activity', [
    cell('Activity type', h(Select, { value: st.activity, options: CUSTOMER_ACTIVITY.options(st.months), onChange: (v) => update({ activity: v }), style: full, 'aria-label': 'Activity type' }), '3 1 260px'),
    cell('Time period', h(Tooltip, { title: periodEnabled ? '' : 'This activity type does not use a time period' }, h(Select, { value: st.months, disabled: !periodEnabled, options: CUSTOMER_ACTIVITY.PERIODS, onChange: (v) => update({ months: v }), style: full, 'aria-label': 'Time period' })), '1 1 150px'),
    cell('Sort by', h(Select, { value: st.sort, options: CUSTOMER_ACTIVITY.SORTS.map((s) => ({ value: s.value, label: s.label })), onChange: (v) => update({ sort: v }), style: full, 'aria-label': 'Sort by' }), '1 1 190px'),
    cell(' ', h(Space, { wrap: true },
      h(Button, { type: 'primary', ghost: true, onClick: () => { const t = getTable(); const rows = (t && t.resource && typeof t.resource.getSelectedRows === 'function' ? t.resource.getSelectedRows() : []) || []; setMsgSelected(rows); setMsgOpen(true); } }, 'Send message'),
      h(Button, { onClick: clearAll }, 'Clear'),
      CAN_IMPORT ? h(Upload, { accept: '.csv,text/csv', showUploadList: false, beforeUpload: importCSV }, h(Tooltip, { title: 'Headers must match the exported CSV' }, h(Button, { loading: busy }, 'Import CSV'))) : null,
      h(Button, { onClick: exportCSV, loading: busy }, 'Export CSV')), '0 0 auto', { marginLeft: 'auto' }),
  ]);

  // What the current selection means, in words, plus the empty state. A polite live region so screen readers hear it.
  const description = CUSTOMER_ACTIVITY.describe({ activity: st.activity, months: st.months, now: new Date(), formatDate: (d) => dayjs(d).format('D MMM YYYY') });
  const sortLabel = (CUSTOMER_ACTIVITY.SORTS.find((s) => s.value === st.sort) || {}).label;
  let note = null;
  if (loadError) note = loadError;
  else if (counts.__view === 0) note = [st.activity === 'all' && !hasOtherFilters(st) ? 'No customers yet. Use Add new to create the first one.' : 'No customers match these filters. ', h(Button, { key: 'clear', type: 'link', size: 'small', onClick: clearAll, style: { padding: 0 } }, 'Clear filters')];
  const statusLine = h('div', { key: 'desc', role: 'status', 'aria-live': 'polite', style: { padding: '10px 14px', borderRadius: 8, background: loadError ? '#fff1f0' : '#fafafa', border: '1px dashed ' + (loadError ? '#ffa39e' : '#d9d9d9'), color: '#4b5563', fontSize: 13 } },
    h('div', null, h('strong', null, activityLabel(st.activity) + ': '), description, st.bday ? ' Sorted by upcoming birthday.' : sortLabel ? ' Sorted: ' + sortLabel.toLowerCase() + '.' : ''),
    note && h('div', { style: { marginTop: 6 } }, note));

  const sendDialog = h(SendMessageDialog, { key: 'send', open: msgOpen, onClose: () => setMsgOpen(false), selected: msgSelected, viewFilter: buildFilter(st), viewCount: counts.__view });

  return h('div', { style: { background: '#fff', border: '1px solid #f0f0f0', borderRadius: 8, padding: 16 } }, kpiRow, generalRow, activityRow, statusLine, sendDialog, h('a', { key: 'dl', ref: dlRef, style: { display: 'none' } }));
}
const CRM_MOBILE_CSS = "\n/* crm-mobile-css v1 — phones & tablets only; desktop (>1024px) untouched */\n@media (max-width: 1024px) {\n  .ant-drawer-left .ant-drawer-content-wrapper { width: min(300px, 85vw) !important; }\n  .ant-drawer-left .ant-layout-sider, .ant-drawer-left .ant-layout-sider-children { width: 100% !important; max-width: none !important; min-width: 0 !important; flex: 1 1 auto !important; }\n  .ant-drawer-left .ant-menu-title-content, .ant-drawer-left .ant-pro-base-menu-inline-item-title { white-space: normal !important; overflow: visible !important; text-overflow: clip !important; line-height: 1.3; }\n  .ant-drawer-left .ant-menu-item { height: auto !important; min-height: 44px; padding-top: 8px !important; padding-bottom: 8px !important; }\n  .rbc-calendar { overflow-x: auto; -webkit-overflow-scrolling: touch; }\n  .rbc-time-view, .rbc-month-view, .rbc-agenda-view { min-width: 680px; }\n  .ant-table-content, .ant-table-body { -webkit-overflow-scrolling: touch; }\n  .ant-modal { max-width: calc(100vw - 16px) !important; }\n  .ant-modal-body { max-height: calc(100vh - 180px); overflow-y: auto; }\n  .ant-drawer-content-wrapper { max-width: 100vw !important; }\n  .ant-drawer-body { overflow-y: auto; -webkit-overflow-scrolling: touch; }\n}\n@media (max-width: 767px) {\n  html, body, .nb-subpages-slot-without-header-and-side > div > div { overflow-x: hidden !important; }\n  .ant-table-thead > tr > th, .ant-table-tbody > tr > td { padding: 8px 8px !important; }\n  .ant-table-tbody > tr > td a, .ant-table-tbody > tr > td .ant-btn-link { display: inline-block; padding: 6px 2px; }\n  .ant-btn:not(.ant-btn-sm):not(.ant-btn-link):not(.ant-btn-text) { min-height: 40px; }\n  .ant-btn-icon-only:not(.ant-btn-sm) { min-width: 40px; }\n  .ant-input, .ant-input-affix-wrapper, .ant-picker:not(.ant-picker-range), .ant-input-number { min-height: 40px; }\n  .ant-select-single:not(.ant-select-sm) { height: auto !important; min-height: 40px; }\n  .ant-select-single:not(.ant-select-sm) .ant-select-selector { min-height: 40px !important; height: auto !important; align-items: center; }\n  .ant-input-affix-wrapper .ant-input, .ant-picker .ant-picker-input input { min-height: 0 !important; }\n  .ant-select-multiple .ant-select-selector { min-height: 40px; }\n  input, textarea, select, .ant-select-selection-search-input { font-size: 16px !important; }\n  .ant-picker-range { width: 100%; min-width: 0; min-height: 40px; }\n  .ant-picker-dropdown .ant-picker-panels { flex-direction: column !important; }\n  .ant-picker-dropdown { max-width: calc(100vw - 8px); }\n  .ant-picker-dropdown .ant-picker-panel-container { overflow: auto; max-height: 80vh; }\n  .ant-form-item-label > label { white-space: normal; height: auto; }\n  .ant-form-item-explain, .ant-form-item-extra { overflow-wrap: anywhere; }\n  .ant-form-item-control-input-content, .ant-descriptions-item-content { overflow-wrap: anywhere; word-break: break-word; min-width: 0; }\n  .ant-card-head-title { white-space: normal; }\n  .rbc-event-label, .rbc-event-content { font-size: 11px; }\n  .rbc-toolbar { flex-wrap: wrap; gap: 6px; }\n  .ant-tabs-nav { margin-bottom: 8px !important; }\n  .ant-space-horizontal.ant-space-align-center, .ant-pro-page-container-extra { flex-wrap: wrap; }\n  .ant-radio-group { display: flex; flex-wrap: wrap; }\n}\n";
ctx.render(h(React.Fragment, null, h('style', { id: 'crm-mobile-css' }, CRM_MOBILE_CSS), h(Toolbar)));
