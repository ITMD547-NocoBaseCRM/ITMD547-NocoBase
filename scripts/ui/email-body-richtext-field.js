// Rich text editor for the reminder / confirmation email body fields (JS editable field).
// Same editor as the "Send message" dialog on the Customers page (scripts/ui/customers-toolbar.js):
// a contentEditable area with a small toolbar (bold, italic, underline, heading, lists, link,
// image by URL, image upload to NocoBase attachments, clear formatting). The field value is the
// raw HTML template, exactly what the plain textarea stored before, so the reminder SQL and the
// delivery workflow keep working unchanged. Placeholders ({{firstName}}, {{staffName}}, ...) are
// typed as plain text inside the editor and are shown as hints below it.
// Deployed by scripts/apply-messages-rich-editor.js via flowSurfaces:addField (renderer: 'js').

const React = ctx.React;
const antd = ctx.antd;
const { useState, useEffect, useRef } = React;
const { Button, Input, message, Tag } = antd;
const h = React.createElement;

const PLACEHOLDERS = ['{{firstName}}', '{{lastName}}', '{{staffName}}', '{{appointmentDate}}', '{{appointmentTime}}'];
const escapeHtml = (s) => String(s || '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
const errText = (e) => (e && e.response && e.response.data && e.response.data.errors && e.response.data.errors[0] && e.response.data.errors[0].message) || (e && e.message) || String(e);

function RichEmailBodyField() {
  const ref = useRef();
  const fileRef = useRef();
  const savedRange = useRef(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const [imageUrlOpen, setImageUrlOpen] = useState(false);
  const [imageUrl, setImageUrl] = useState('');
  const [uploading, setUploading] = useState(false);

  // Initial value, and external value changes (the edit form loads the record after mount).
  useEffect(() => {
    const el = ref.current;
    if (el) el.innerHTML = String(ctx.getValue?.() ?? '');
    const handler = (ev) => {
      const node = ref.current;
      if (!node) return;
      const next = String(ev?.detail ?? '');
      const active = node.ownerDocument.activeElement;
      const focused = active === node || node.contains(active);
      if (!focused && node.innerHTML !== next) node.innerHTML = next;
    };
    ctx.element?.addEventListener('js-field:value-change', handler);
    return () => ctx.element?.removeEventListener('js-field:value-change', handler);
  }, []);

  const emit = () => { const el = ref.current; if (el) ctx.setValue?.(el.innerHTML); };
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
    doc().execCommand('insertHTML', false, '<img src="' + escapeHtml(parsed.href) + '" alt="Email image" style="max-width:100%;height:auto;display:block;margin:8px 0" />');
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

  return h('div', null,
    h('div', { style: { border: '1px solid #d9d9d9', borderRadius: 6 } }, toolbar,
      h('div', { ref, contentEditable: true, suppressContentEditableWarning: true, role: 'textbox', 'aria-multiline': true, 'aria-label': 'Email body', 'data-placeholder': 'Write the email content…',
        onInput: emit, onBlur: emit, onKeyUp: saveRange, onMouseUp: saveRange,
        style: { minHeight: 180, maxHeight: 360, overflow: 'auto', padding: '10px 12px', outline: 'none', fontSize: 14, lineHeight: 1.5 } }),
      h('style', null, '[data-placeholder]:empty:before{content:attr(data-placeholder);color:#9ca3af}')),
    h('div', { style: { marginTop: 4, fontSize: 12, color: '#6b7280' } }, 'Placeholders: ', PLACEHOLDERS.map((p) => h(Tag, { key: p, style: { marginRight: 4 } }, p))));
}

function ReadOnlyEmailBody() {
  const [value, setValue] = useState(String(ctx.getValue?.() ?? ''));
  useEffect(() => {
    const handler = (ev) => setValue(String(ev?.detail ?? ''));
    ctx.element?.addEventListener('js-field:value-change', handler);
    return () => ctx.element?.removeEventListener('js-field:value-change', handler);
  }, []);
  return h('div', { style: { border: '1px solid #f0f0f0', borderRadius: 6, padding: '8px 12px', background: '#fafafa' }, dangerouslySetInnerHTML: { __html: value } });
}

const isReadOnly = !!(ctx.model && ctx.model.props && (ctx.model.props.readOnly || ctx.model.props.pattern === 'readPretty'));
ctx.render(h(isReadOnly ? ReadOnlyEmailBody : RichEmailBodyField));
