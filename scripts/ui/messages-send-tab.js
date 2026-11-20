// "Send Messages" tab on the Messages page (JS block): helpdesk-style messaging UI.
// Three panes, like a support inbox: searchable customer list (left), the conversation with the
// selected customer (center: past messages from the customerMessages outbox, newest at the bottom,
// with a compose box using the same rich text editor as the Customers page "Send message" dialog),
// and the customer's contact card (right). Sending creates a customerMessages row (status
// "queued"); the "Deliver customer messages" workflow sends it, and the thread shows
// queued / sent / failed per message. Bulk sending to many customers stays on the Customers page.
// Deployed by scripts/apply-messages-rich-editor.js via flowSurfaces (JS block).

const React = ctx.React; const antd = ctx.antd; const dayjs = ctx.dayjs;
const { useState, useEffect, useRef } = React;
const { Input, Button, Radio, Tag, message, Spin, Empty, Tooltip } = antd;
const h = React.createElement;

const MSG_COLLECTION = 'customerMessages';
const CUSTOMERS = 'customers';
const SMS_LIMIT = 320;
const CONTACT_FIELDS = ['id', 'firstName', 'lastName', 'email', 'phone', 'status', 'createdAt', 'visitCount', 'lastVisitAt', 'totalSpent'];

const req = async (url, params) => (await ctx.api.request({ url, params })).data;
const errText = (e) => (e && e.response && e.response.data && e.response.data.errors && e.response.data.errors[0] && e.response.data.errors[0].message) || (e && e.message) || String(e);
const escapeHtml = (s) => String(s || '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
const textToHtml = (s) => '<p>' + escapeHtml(s).replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br/>') + '</p>';
const EMAIL_WRAP = (inner) => '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#111827;max-width:640px">' + inner + '</div>';
const renderTemplate = (template, customer) => {
  const values = { firstName: customer.firstName || '', lastName: customer.lastName || '', fullName: [customer.firstName, customer.lastName].filter(Boolean).join(' ') };
  return String(template || '').replace(/\{\{\s*(firstName|lastName|fullName)\s*\}\}/g, (_, key) => values[key]);
};
const fullName = (c) => [c.firstName, c.lastName].filter(Boolean).join(' ') || c.email || ('#' + c.id);
const initials = (c) => ((c.firstName || '').charAt(0) + (c.lastName || '').charAt(0)).toUpperCase() || '?';

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

const STATUS_COLORS = { queued: 'gold', sent: 'green', failed: 'red' };
const AVATAR_BG = ['#b45309', '#0e7490', '#6d28d9', '#be185d', '#15803d', '#b91c1c'];
const avatarColor = (id) => AVATAR_BG[Math.abs(Number(id) || 0) % AVATAR_BG.length];

function Avatar({ customer, size = 36 }) {
  return h('div', { style: { width: size, height: size, minWidth: size, borderRadius: '50%', background: avatarColor(customer.id), color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: size * 0.38, fontWeight: 600 } }, initials(customer));
}

// Same rich text editor as the Customers page "Send message" dialog (compact height for the composer).
function RichEditor({ html, onChange, placeholder }) {
  const ref = useRef();
  const fileRef = useRef();
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const [imageUrlOpen, setImageUrlOpen] = useState(false);
  const [imageUrl, setImageUrl] = useState('');
  const [uploading, setUploading] = useState(false);
  const savedRange = useRef(null);
  useEffect(() => { if (ref.current && ref.current.innerHTML !== (html || '')) ref.current.innerHTML = html || ''; }, []);
  useEffect(() => { if (ref.current && (html || '') === '' && ref.current.innerHTML !== '') ref.current.innerHTML = ''; }, [html]);
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
  const applyImageUrl = () => {
    const value = imageUrl.trim();
    if (!value) return;
    let parsed;
    try { parsed = new window.URL(value); } catch (e) { message.error('Enter a valid image URL.'); return; }
    if (parsed.protocol !== 'https:') { message.error('Use a public HTTPS image URL so email clients can load it.'); return; }
    setImageUrlOpen(false);
    ref.current.focus(); restoreRange();
    doc().execCommand('insertHTML', false, '<img src="' + escapeHtml(parsed.href) + '" alt="Offer image" style="max-width:100%;height:auto;display:block;margin:8px 0" />');
    emit(); setImageUrl('');
  };
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
    tb('Image URL', 'Insert image from a public HTTPS URL', () => { saveRange(); setImageUrlOpen(true); }),
    tb(uploading ? 'Uploading…' : 'Upload', 'Upload image to NocoBase', () => { saveRange(); fileRef.current && fileRef.current.click(); }, { loading: uploading }),
    tb('Clear', 'Remove formatting', () => exec('removeFormat')),
    h('input', { key: 'file', ref: fileRef, type: 'file', accept: 'image/*', style: { display: 'none' }, onChange: (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; insertImage(f); } }),
    linkOpen && h('span', { key: 'link', style: { display: 'inline-flex', gap: 4, alignItems: 'center', marginLeft: 6 } },
      h(Input, { size: 'small', autoFocus: true, placeholder: 'https://', value: linkUrl, onChange: (e) => setLinkUrl(e.target.value), onPressEnter: applyLink, style: { width: 220 } }),
      h(Button, { size: 'small', type: 'primary', onClick: applyLink }, 'Add'),
      h(Button, { size: 'small', onClick: () => setLinkOpen(false) }, 'Cancel')),
    imageUrlOpen && h('span', { key: 'image-url', style: { display: 'inline-flex', gap: 4, alignItems: 'center', marginLeft: 6 } },
      h(Input, { size: 'small', autoFocus: true, placeholder: 'https://example.com/offer.jpg', value: imageUrl, onChange: (e) => setImageUrl(e.target.value), onPressEnter: applyImageUrl, style: { width: 300 } }),
      h(Button, { size: 'small', type: 'primary', onClick: applyImageUrl }, 'Insert'),
      h(Button, { size: 'small', onClick: () => { setImageUrlOpen(false); setImageUrl(''); } }, 'Cancel')));
  return h('div', { style: { border: '1px solid #d9d9d9', borderRadius: 6, background: '#fff' } }, toolbar,
    h('div', { ref, contentEditable: true, suppressContentEditableWarning: true, role: 'textbox', 'aria-multiline': true, 'aria-label': 'Email message', 'data-placeholder': placeholder,
      onInput: emit, onBlur: emit, onKeyUp: saveRange, onMouseUp: saveRange,
      style: { minHeight: 90, maxHeight: 220, overflow: 'auto', padding: '8px 12px', outline: 'none', fontSize: 14, lineHeight: 1.5 } }),
    h('style', null, '[data-placeholder]:empty:before{content:attr(data-placeholder);color:#9ca3af}'));
}

function MessagesWorkspace() {
  const [query, setQuery] = useState('');
  const [customers, setCustomers] = useState(null);
  const [selected, setSelected] = useState(null);
  const [thread, setThread] = useState(null);
  const [channel, setChannel] = useState('email');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [bodyHtml, setBodyHtml] = useState('');
  const [sending, setSending] = useState(false);
  const threadRef = useRef();
  const searchSeq = useRef(0);

  const loadCustomers = async (q) => {
    const seq = ++searchSeq.current;
    try {
      const text = String(q || '').trim();
      const params = { pageSize: 50, fields: CONTACT_FIELDS, sort: ['firstName'] };
      if (text) params.filter = { $or: [{ firstName: { $includes: text } }, { lastName: { $includes: text } }, { email: { $includes: text } }, { phone: { $includes: text } }] };
      const r = await req(CUSTOMERS + ':list', params);
      if (seq === searchSeq.current) setCustomers(r.data || []);
    } catch (e) { if (seq === searchSeq.current) { setCustomers([]); message.error('Could not load customers: ' + errText(e)); } }
  };
  useEffect(() => { loadCustomers(''); }, []);

  const loadThread = async (customer) => {
    if (!customer) return;
    try {
      const r = await req(MSG_COLLECTION + ':list', { pageSize: 100, filter: { customerId: customer.id }, sort: ['-createdAt'] });
      setThread((r.data || []).slice().reverse());
      setTimeout(() => { const el = threadRef.current; if (el) el.scrollTop = el.scrollHeight; }, 50);
    } catch (e) { setThread([]); message.error('Could not load messages: ' + errText(e)); }
  };
  useEffect(() => { if (selected) { setThread(null); loadThread(selected); } }, [selected && selected.id]);

  // Default the channel to something the selected customer can actually receive.
  useEffect(() => {
    if (!selected) return;
    const canEmail = selected.email && /\S+@\S+/.test(selected.email);
    const canSms = !!toE164(selected.phone);
    if (channel === 'email' && !canEmail && canSms) setChannel('sms');
    if (channel === 'sms' && !canSms && canEmail) setChannel('email');
  }, [selected && selected.id]);

  const canEmail = selected && selected.email && /\S+@\S+/.test(selected.email);
  const canSms = selected && !!toE164(selected.phone);
  const wantsEmail = channel === 'email';
  const smsTooLong = !wantsEmail && body.length > SMS_LIMIT;
  const hasContent = body.trim() || /<img\b/i.test(bodyHtml);
  const canSend = selected && !sending && hasContent && !smsTooLong && (wantsEmail ? (canEmail && subject.trim()) : canSms);
  const emailHtml = (c) => EMAIL_WRAP(renderTemplate(bodyHtml && bodyHtml.replace(/<[^>]+>/g, '').trim() === '' && !/<img\b/i.test(bodyHtml) ? textToHtml(body) : (bodyHtml || textToHtml(body)), c));

  const send = async () => {
    if (!selected) return;
    setSending(true);
    try {
      const data = wantsEmail
        ? { customer: { id: selected.id }, channel: 'email', recipient: selected.email.trim(), subject: renderTemplate(subject, selected), body: renderTemplate(body, selected), bodyHtml: emailHtml(selected), status: 'queued', batchKey: 'chat-' + dayjs().format('YYYYMMDD-HHmmss') }
        : { customer: { id: selected.id }, channel: 'sms', recipient: toE164(selected.phone), subject: null, body: renderTemplate(body, selected), status: 'queued', batchKey: 'chat-' + dayjs().format('YYYYMMDD-HHmmss') };
      await ctx.api.request({ url: MSG_COLLECTION + ':create', method: 'post', data });
      setBody(''); setBodyHtml(''); setSubject('');
      message.success('Message queued for delivery.');
      await loadThread(selected);
    } catch (e) { message.error('Send failed: ' + errText(e)); }
    finally { setSending(false); }
  };

  // ── Left: customer list ──
  const left = h('div', { style: { width: 260, minWidth: 260, borderRight: '1px solid #f0f0f0', display: 'flex', flexDirection: 'column', background: '#fff' } },
    h('div', { style: { padding: 10, borderBottom: '1px solid #f0f0f0' } },
      h(Input, { allowClear: true, placeholder: 'Search customers…', value: query, onChange: (e) => { setQuery(e.target.value); loadCustomers(e.target.value); } })),
    h('div', { style: { flex: 1, overflowY: 'auto' } },
      customers === null ? h('div', { style: { padding: 24, textAlign: 'center' } }, h(Spin)) :
      customers.length === 0 ? h(Empty, { image: Empty.PRESENTED_IMAGE_SIMPLE, description: 'No customers', style: { marginTop: 32 } }) :
      customers.map((c) => h('div', {
        key: c.id, onClick: () => setSelected(c),
        style: { display: 'flex', gap: 10, alignItems: 'center', padding: '10px 12px', cursor: 'pointer', background: selected && selected.id === c.id ? '#fff2e8' : 'transparent', borderLeft: selected && selected.id === c.id ? '3px solid #d4621c' : '3px solid transparent' } },
        h(Avatar, { customer: c, size: 34 }),
        h('div', { style: { minWidth: 0 } },
          h('div', { style: { fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, fullName(c)),
          h('div', { style: { fontSize: 12, color: '#8c8c8c', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, c.email || c.phone || 'No contact info'))))));

  // ── Center: conversation ──
  const bubble = (m) => h('div', { key: m.id, style: { marginLeft: 'auto', maxWidth: '75%', background: '#fff', border: '1px solid #e5e7eb', borderRadius: '12px 12px 2px 12px', padding: '8px 12px', marginBottom: 10, boxShadow: '0 1px 2px rgba(0,0,0,0.04)' } },
    h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4 } },
      h(Tag, { style: { marginRight: 0 } }, (m.channel || '').toUpperCase()),
      h(Tag, { color: STATUS_COLORS[m.status] || 'default', style: { marginRight: 0 } }, m.status),
      h('span', { style: { fontSize: 11, color: '#9ca3af' } }, m.createdAt ? dayjs(m.createdAt).format('MMM D, YYYY h:mm A') : '')),
    m.subject && h('div', { style: { fontWeight: 600, fontSize: 13, marginBottom: 2 } }, m.subject),
    m.channel === 'email' && m.bodyHtml
      ? h('div', { style: { fontSize: 13, overflow: 'hidden' }, dangerouslySetInnerHTML: { __html: m.bodyHtml } })
      : h('div', { style: { fontSize: 13, whiteSpace: 'pre-wrap' } }, m.body),
    m.status === 'failed' && m.error && h('div', { style: { fontSize: 11, color: '#dc2626', marginTop: 4 } }, m.error));

  const composer = selected && h('div', { style: { borderTop: '1px solid #f0f0f0', padding: 12, background: '#fff', display: 'flex', flexDirection: 'column', gap: 8 } },
    h('div', { style: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' } },
      h(Radio.Group, { size: 'small', value: channel, onChange: (e) => setChannel(e.target.value), optionType: 'button', buttonStyle: 'solid' },
        h(Radio.Button, { value: 'email', disabled: !canEmail }, 'Email'),
        h(Radio.Button, { value: 'sms', disabled: !canSms }, 'SMS')),
      !canEmail && channel === 'email' && h('span', { style: { fontSize: 12, color: '#b45309' } }, 'This customer has no email address.'),
      !canSms && channel === 'sms' && h('span', { style: { fontSize: 12, color: '#b45309' } }, 'This customer has no usable phone number.')),
    wantsEmail && h(Input, { value: subject, maxLength: 150, onChange: (e) => setSubject(e.target.value), placeholder: 'Subject…' }),
    wantsEmail
      ? h(RichEditor, { html: bodyHtml, onChange: ({ html: nextHtml, text }) => { setBodyHtml(nextHtml); setBody(text.replace(/ /g, ' ').trim()); }, placeholder: 'Hi {{firstName}}, …' })
      : h(Input.TextArea, { value: body, rows: 3, onChange: (e) => { setBody(e.target.value); setBodyHtml(''); }, placeholder: 'Hi {{firstName}}, …' }),
    h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
      h('span', { style: { fontSize: 12, color: smsTooLong ? '#dc2626' : '#8c8c8c' } },
        'Placeholders: {{firstName}} {{lastName}} {{fullName}}', !wantsEmail ? ' · ' + body.length + ' / ' + SMS_LIMIT : ''),
      h(Button, { type: 'primary', loading: sending, disabled: !canSend, onClick: send }, wantsEmail ? 'Send email' : 'Send SMS')));

  const center = h('div', { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: '#fafafa' } },
    selected
      ? [
          h('div', { key: 'head', style: { display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderBottom: '1px solid #f0f0f0', background: '#fff' } },
            h(Avatar, { customer: selected, size: 32 }),
            h('div', { style: { flex: 1, minWidth: 0 } },
              h('div', { style: { fontWeight: 600 } }, 'Conversation with ' + fullName(selected)),
              h('div', { style: { fontSize: 12, color: '#8c8c8c' } }, [canEmail && selected.email, canSms && selected.phone].filter(Boolean).join(' · ') || 'No contact info')),
            h(Button, { size: 'small', onClick: () => loadThread(selected) }, 'Refresh')),
          h('div', { key: 'thread', ref: threadRef, style: { flex: 1, overflowY: 'auto', padding: 16 } },
            thread === null ? h('div', { style: { textAlign: 'center', paddingTop: 40 } }, h(Spin)) :
            thread.length === 0 ? h(Empty, { image: Empty.PRESENTED_IMAGE_SIMPLE, description: 'No messages yet. Start the conversation below.', style: { marginTop: 48 } }) :
            thread.map(bubble)),
          composer,
        ]
      : h('div', { style: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' } },
          h(Empty, { image: Empty.PRESENTED_IMAGE_SIMPLE, description: 'Select a customer to view the conversation and send a message' })));

  // ── Right: contact card ──
  const row = (label, value) => value != null && value !== '' && h('div', { key: label, style: { marginBottom: 10 } },
    h('div', { style: { fontSize: 11, color: '#8c8c8c', textTransform: 'uppercase', letterSpacing: 0.4 } }, label),
    h('div', { style: { fontSize: 13, overflowWrap: 'anywhere' } }, String(value)));
  const right = h('div', { style: { width: 270, minWidth: 270, borderLeft: '1px solid #f0f0f0', background: '#fff', overflowY: 'auto', padding: 16 } },
    selected
      ? [
          h('div', { key: 'top', style: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 } },
            h(Avatar, { customer: selected, size: 44 }),
            h('div', null,
              h('div', { style: { fontWeight: 600 } }, fullName(selected)),
              selected.status && h(Tag, { color: selected.status === 'active' ? 'green' : 'default', style: { marginTop: 2 } }, selected.status))),
          row('Email', selected.email),
          row('Phone', selected.phone),
          row('Customer since', selected.createdAt ? dayjs(selected.createdAt).format('MMM D, YYYY') : null),
          row('Completed visits', selected.visitCount),
          row('Last visit', selected.lastVisitAt ? dayjs(selected.lastVisitAt).format('MMM D, YYYY') : null),
          row('Total spent', selected.totalSpent != null ? '$' + Number(selected.totalSpent).toFixed(2) : null),
        ]
      : h('div', { style: { color: '#bfbfbf', fontSize: 13, textAlign: 'center', marginTop: 40 } }, 'Customer details appear here'));

  return h('div', { style: { display: 'flex', border: '1px solid #f0f0f0', borderRadius: 8, overflow: 'hidden', height: 'calc(100vh - 230px)', minHeight: 520, background: '#fff' } }, left, center, right);
}

ctx.render(h(MessagesWorkspace));
