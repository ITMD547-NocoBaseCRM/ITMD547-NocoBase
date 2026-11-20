// "Coupons" tab on the Offers page (JS block): generate, edit and manage discount coupons.
// Each coupon has a unique code, a percent or fixed discount, a scope (all services or one
// particular service), a validity window, a per-customer limit and an overall limit. Usage is
// tracked in couponRedemptions, and the Redeem dialog (one common button in the toolbar)
// enforces the limits and dates before recording a redemption. Codes use an unambiguous
// alphabet (no 0/O or 1/I/L).
// Deployed by scripts/apply-coupons.js via flowSurfaces (JS block).

const React = ctx.React; const antd = ctx.antd; const dayjs = ctx.dayjs;
const { useState, useEffect, useRef } = React;
const { Input, InputNumber, Select, DatePicker, Button, Radio, Tag, Modal, message, Spin, Empty, Table, Tooltip, Popconfirm } = antd;
const h = React.createElement;

const COUPONS = 'coupons';
const REDEMPTIONS = 'couponRedemptions';
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const req = async (url, params) => (await ctx.api.request({ url, params })).data;
const post = (url, data) => ctx.api.request({ url, method: 'post', data });
const errText = (e) => (e && e.response && e.response.data && e.response.data.errors && e.response.data.errors[0] && e.response.data.errors[0].message) || (e && e.message) || String(e);

const generateCode = (prefix = 'BW', length = 6) => {
  let out = '';
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return prefix + '-' + out;
};
const describeDiscount = (c) => c.discountType === 'fixed'
  ? '$' + Number(c.discountValue || 0).toFixed(2).replace(/\.00$/, '') + ' off'
  : Number(c.discountValue || 0) + '% off';
const limitText = (n) => (n ? String(n) : '∞');
const couponLabel = (c) => c.code + (c.name ? ' · ' + c.name : '');

// Same rules as scripts/coupons.js validateCoupon.
const validateCoupon = (coupon, { now = new Date(), totalRedemptions = 0, customerRedemptions = 0 } = {}) => {
  if (!coupon) return { ok: false, reason: 'Coupon not found.' };
  if (coupon.status !== 'active') return { ok: false, reason: 'This coupon is disabled.' };
  if (coupon.validFrom && now < new Date(coupon.validFrom)) return { ok: false, reason: 'This coupon is not valid yet.' };
  if (coupon.validUntil && now > new Date(coupon.validUntil)) return { ok: false, reason: 'This coupon has expired.' };
  if (coupon.totalLimit && totalRedemptions >= coupon.totalLimit) return { ok: false, reason: 'This coupon has reached its overall usage limit.' };
  if (coupon.perCustomerLimit && customerRedemptions >= coupon.perCustomerLimit) return { ok: false, reason: 'This customer has already used this coupon the maximum number of times.' };
  return { ok: true };
};

// Create AND edit: pass coupon=null for a new one, or the row to edit.
function CouponFormModal({ open, onClose, coupon, services, onSaved }) {
  const blank = () => ({ code: generateCode(), name: '', discountType: 'percent', discountValue: 10, appliesTo: 'all', serviceId: null, range: null, perCustomerLimit: 1, totalLimit: 0 });
  const [form, setForm] = useState(blank);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!open) return;
    if (!coupon) { setForm(blank()); return; }
    setForm({
      code: coupon.code || '',
      name: coupon.name || '',
      discountType: coupon.discountType || 'percent',
      discountValue: Number(coupon.discountValue) || 0,
      appliesTo: coupon.appliesTo || 'all',
      serviceId: coupon.serviceId || (coupon.service && coupon.service.id) || null,
      range: [coupon.validFrom ? dayjs(coupon.validFrom) : null, coupon.validUntil ? dayjs(coupon.validUntil) : null],
      perCustomerLimit: Number(coupon.perCustomerLimit) || 0,
      totalLimit: Number(coupon.totalLimit) || 0,
    });
  }, [open]);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const canSave = form.code.trim() && form.discountValue > 0 && (form.discountType !== 'percent' || form.discountValue <= 100) && (form.appliesTo === 'all' || form.serviceId);

  const save = async () => {
    setSaving(true);
    try {
      const values = {
        code: form.code.trim().toUpperCase(),
        name: form.name.trim(),
        discountType: form.discountType,
        discountValue: form.discountValue,
        appliesTo: form.appliesTo,
        service: form.appliesTo === 'service' && form.serviceId ? { id: form.serviceId } : null,
        validFrom: form.range && form.range[0] ? form.range[0].startOf('day').toISOString() : null,
        validUntil: form.range && form.range[1] ? form.range[1].endOf('day').toISOString() : null,
        perCustomerLimit: form.perCustomerLimit || 0,
        totalLimit: form.totalLimit || 0,
      };
      if (coupon) await post(COUPONS + ':update?filterByTk=' + coupon.id, values);
      else await post(COUPONS + ':create', { ...values, status: 'active' });
      message.success('Coupon ' + values.code + (coupon ? ' updated.' : ' created.'));
      onSaved(); onClose();
    } catch (e) { message.error('Could not save coupon: ' + errText(e)); }
    finally { setSaving(false); }
  };

  const label = (text) => h('div', { style: { fontWeight: 600, marginBottom: 4, marginTop: 10 } }, text);
  return h(Modal, {
    open, title: coupon ? 'Edit ' + (coupon.code || 'coupon') : 'Generate coupon', onCancel: onClose, width: 520, destroyOnClose: true,
    footer: [h(Button, { key: 'c', onClick: onClose }, 'Cancel'), h(Button, { key: 's', type: 'primary', loading: saving, disabled: !canSave, onClick: save }, coupon ? 'Save changes' : 'Create coupon')],
  },
  h('div', null,
    label('Code'),
    h('div', { style: { display: 'flex', gap: 8 } },
      h(Input, { value: form.code, onChange: (e) => set({ code: e.target.value.toUpperCase() }), style: { fontFamily: 'monospace' } }),
      h(Button, { onClick: () => set({ code: generateCode() }) }, 'Regenerate')),
    coupon && h('div', { style: { fontSize: 12, color: '#b45309', marginTop: 4 } }, 'Changing the code invalidates anything already sent out with the old code.'),
    label('Campaign name (optional)'),
    h(Input, { value: form.name, maxLength: 100, onChange: (e) => set({ name: e.target.value }), placeholder: 'Spring promo' }),
    label('Discount'),
    h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
      h(Radio.Group, { value: form.discountType, optionType: 'button', buttonStyle: 'solid', onChange: (e) => set({ discountType: e.target.value }) },
        h(Radio.Button, { value: 'percent' }, 'Percent %'),
        h(Radio.Button, { value: 'fixed' }, 'Fixed $')),
      h(InputNumber, { min: 0.01, max: form.discountType === 'percent' ? 100 : undefined, value: form.discountValue, onChange: (v) => set({ discountValue: v }), style: { width: 120 } }),
      h('span', { style: { color: '#8c8c8c' } }, form.discountType === 'percent' ? '% off' : '$ off')),
    label('Applies to'),
    h(Radio.Group, { value: form.appliesTo, onChange: (e) => set({ appliesTo: e.target.value }) },
      h(Radio, { value: 'all' }, 'All services'),
      h(Radio, { value: 'service' }, 'A particular service')),
    form.appliesTo === 'service' && h(Select, {
      showSearch: true, optionFilterProp: 'label', value: form.serviceId, onChange: (v) => set({ serviceId: v }),
      placeholder: 'Select a service…', style: { width: '100%', marginTop: 8 },
      options: services.map((s) => ({ value: s.id, label: s.name + (s.price != null ? ' ($' + s.price + ')' : '') })),
    }),
    label('Valid dates'),
    h(DatePicker.RangePicker, { value: form.range, onChange: (v) => set({ range: v }), style: { width: '100%' }, allowEmpty: [true, true], placeholder: ['Valid from (optional)', 'Valid until (optional)'] }),
    h('div', { style: { display: 'flex', gap: 24 } },
      h('div', { style: { flex: 1 } }, label('Limit per customer'),
        h(InputNumber, { min: 0, precision: 0, value: form.perCustomerLimit, onChange: (v) => set({ perCustomerLimit: v }), style: { width: '100%' } }),
        h('div', { style: { fontSize: 12, color: '#8c8c8c', marginTop: 2 } }, '0 = unlimited')),
      h('div', { style: { flex: 1 } }, label('Overall limit'),
        h(InputNumber, { min: 0, precision: 0, value: form.totalLimit, onChange: (v) => set({ totalLimit: v }), style: { width: '100%' } }),
        h('div', { style: { fontSize: 12, color: '#8c8c8c', marginTop: 2 } }, '0 = unlimited')))));
}

// One common Redeem dialog: pick the coupon, pick the customer, validate, record.
function RedeemModal({ open, onClose, coupons, usageByCoupon, onRedeemed }) {
  const [couponId, setCouponId] = useState(null);
  const [customers, setCustomers] = useState([]);
  const [customerId, setCustomerId] = useState(null);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [checkResult, setCheckResult] = useState(null);
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
  useEffect(() => { if (open) { setCouponId(null); setCustomerId(null); setNote(''); setCheckResult(null); search(''); } }, [open]);

  const coupon = coupons.find((c) => String(c.id) === String(couponId)) || null;

  useEffect(() => {
    if (!open || !coupon || !customerId) { setCheckResult(null); return; }
    (async () => {
      try {
        const r = await req(REDEMPTIONS + ':list', { paginate: false, fields: ['id', 'customerId'], filter: { couponId: coupon.id } });
        const rows = r.data || [];
        const result = validateCoupon(coupon, {
          totalRedemptions: rows.length,
          customerRedemptions: rows.filter((x) => String(x.customerId) === String(customerId)).length,
        });
        setCheckResult(result);
      } catch (e) { setCheckResult({ ok: false, reason: 'Could not check usage: ' + errText(e) }); }
    })();
  }, [open, couponId, customerId]);

  const redeem = async () => {
    setSaving(true);
    try {
      await post(REDEMPTIONS + ':create', { coupon: { id: coupon.id }, customer: { id: customerId }, redeemedAt: new Date().toISOString(), note: note.trim() || null });
      message.success('Coupon ' + coupon.code + ' redeemed.');
      onRedeemed(); onClose();
    } catch (e) { message.error('Could not redeem: ' + errText(e)); }
    finally { setSaving(false); }
  };

  return h(Modal, {
    open, title: 'Redeem a coupon', onCancel: onClose, width: 460, destroyOnClose: true,
    footer: [h(Button, { key: 'c', onClick: onClose }, 'Cancel'),
      h(Button, { key: 'r', type: 'primary', loading: saving, disabled: !couponId || !customerId || !checkResult || !checkResult.ok, onClick: redeem }, 'Redeem')],
  },
  h('div', null,
    h('div', { style: { fontWeight: 600, marginBottom: 4 } }, 'Coupon'),
    h(Select, {
      showSearch: true, optionFilterProp: 'label', value: couponId, onChange: setCouponId,
      placeholder: 'Type or pick the coupon code…', style: { width: '100%' },
      options: coupons.map((c) => ({ value: c.id, label: couponLabel(c) })),
    }),
    coupon && h('div', { style: { margin: '8px 0 0', color: '#4b5563', fontSize: 13 } },
      describeDiscount(coupon) + ' · ' + (coupon.appliesTo === 'service' ? (coupon.service && coupon.service.name ? 'Only ' + coupon.service.name : 'One service') : 'All services') +
      ' · used ' + (usageByCoupon[coupon.id] || 0) + ' / ' + limitText(coupon.totalLimit)),
    h('div', { style: { fontWeight: 600, marginBottom: 4, marginTop: 12 } }, 'Customer'),
    h(Select, {
      showSearch: true, filterOption: false, value: customerId, onSearch: search, onChange: setCustomerId,
      placeholder: 'Search customer…', style: { width: '100%' },
      options: customers.map((c) => ({ value: c.id, label: [c.firstName, c.lastName].filter(Boolean).join(' ') + (c.email ? ' · ' + c.email : '') })),
    }),
    h('div', { style: { fontWeight: 600, marginBottom: 4, marginTop: 10 } }, 'Note (optional)'),
    h(Input, { value: note, maxLength: 150, onChange: (e) => setNote(e.target.value), placeholder: 'e.g. applied to appointment on Dec 2' }),
    couponId && customerId && checkResult && h('div', { style: { marginTop: 12 } },
      checkResult.ok
        ? h(Tag, { color: 'green' }, 'Valid — ready to redeem')
        : h(Tag, { color: 'red' }, checkResult.reason))));
}

function CouponsPanel() {
  const [coupons, setCoupons] = useState(null);
  const [usageByCoupon, setUsageByCoupon] = useState({});
  const [services, setServices] = useState([]);
  const [formFor, setFormFor] = useState(null);     // null closed | { coupon: null | row }
  const [redeemOpen, setRedeemOpen] = useState(false);

  const load = async () => {
    try {
      const r = await req(COUPONS + ':list', { paginate: false, sort: ['-createdAt'], appends: ['service'] });
      const rows = r.data || [];
      setCoupons(rows);
      if (rows.length) {
        const red = await req(REDEMPTIONS + ':list', { paginate: false, fields: ['id', 'couponId'], filter: { couponId: { $in: rows.map((c) => c.id) } } });
        const counts = {};
        for (const x of (red.data || [])) counts[x.couponId] = (counts[x.couponId] || 0) + 1;
        setUsageByCoupon(counts);
      } else setUsageByCoupon({});
    } catch (e) { setCoupons([]); message.error('Could not load coupons: ' + errText(e)); }
  };
  useEffect(() => {
    load();
    (async () => {
      try { const r = await req('services:list', { paginate: false, fields: ['id', 'name', 'price'], filter: { active: true }, sort: ['name'] }); setServices(r.data || []); }
      catch (e) { setServices([]); }
    })();
  }, []);

  const setStatus = async (coupon, status) => {
    try { await post(COUPONS + ':update?filterByTk=' + coupon.id, { status }); message.success(coupon.code + (status === 'active' ? ' enabled.' : ' disabled.')); load(); }
    catch (e) { message.error(errText(e)); }
  };
  const remove = async (coupon) => {
    try { await ctx.api.request({ url: COUPONS + ':destroy?filterByTk=' + coupon.id, method: 'post' }); message.success(coupon.code + ' deleted.'); load(); }
    catch (e) { message.error(errText(e)); }
  };
  const copyCode = async (code) => {
    try { await navigator.clipboard.writeText(code); message.success(code + ' copied.'); }
    catch (e) { message.info(code); }
  };

  const now = new Date();
  const stateOf = (c) => {
    const used = usageByCoupon[c.id] || 0;
    if (c.status !== 'active') return { label: 'Disabled', color: 'default' };
    if (c.validFrom && now < new Date(c.validFrom)) return { label: 'Scheduled', color: 'blue' };
    if (c.validUntil && now > new Date(c.validUntil)) return { label: 'Expired', color: 'red' };
    if (c.totalLimit && used >= c.totalLimit) return { label: 'Used up', color: 'orange' };
    return { label: 'Active', color: 'green' };
  };
  const fmtDate = (v) => (v ? dayjs(v).format('MMM D, YYYY') : null);

  const columns = [
    { title: 'Code', dataIndex: 'code', render: (code) => h(Tooltip, { title: 'Click to copy' }, h('span', { onClick: () => copyCode(code), style: { fontFamily: 'monospace', fontWeight: 600, cursor: 'pointer', background: '#fff2e8', padding: '2px 8px', borderRadius: 4, border: '1px dashed #d4621c' } }, code)) },
    { title: 'Campaign', dataIndex: 'name', render: (v) => v || h('span', { style: { color: '#bfbfbf' } }, '—') },
    { title: 'Discount', render: (c) => h('strong', null, describeDiscount(c)) },
    { title: 'Applies to', render: (c) => c.appliesTo === 'service' ? h(Tag, { color: 'purple' }, (c.service && c.service.name) || 'One service') : h(Tag, null, 'All services') },
    { title: 'Valid', render: (c) => { const a = fmtDate(c.validFrom); const b = fmtDate(c.validUntil); return a || b ? h('span', { style: { fontSize: 12 } }, (a || 'Any time') + ' → ' + (b || 'no end')) : h('span', { style: { color: '#bfbfbf', fontSize: 12 } }, 'Always'); } },
    { title: 'Used', render: (c) => h('span', null, (usageByCoupon[c.id] || 0) + ' / ' + limitText(c.totalLimit)) },
    { title: 'Per customer', render: (c) => limitText(c.perCustomerLimit) },
    { title: 'Status', render: (c) => { const s = stateOf(c); return h(Tag, { color: s.color }, s.label); } },
    { title: 'Actions', render: (c) => h('span', { style: { whiteSpace: 'nowrap' } },
      h(Button, { size: 'small', type: 'link', onClick: () => setFormFor({ coupon: c }) }, 'Edit'),
      c.status === 'active'
        ? h(Button, { size: 'small', type: 'link', onClick: () => setStatus(c, 'disabled') }, 'Disable')
        : h(Button, { size: 'small', type: 'link', onClick: () => setStatus(c, 'active') }, 'Enable'),
      h(Popconfirm, { title: 'Delete ' + c.code + '?', description: 'Its redemption history is kept.', onConfirm: () => remove(c) },
        h(Button, { size: 'small', type: 'link', danger: true }, 'Delete'))) },
  ];

  return h('div', { style: { background: '#fff', border: '1px solid #f0f0f0', borderRadius: 8, padding: 16 } },
    h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, flexWrap: 'wrap', gap: 8 } },
      h('div', null,
        h('div', { style: { fontWeight: 600, fontSize: 16 } }, 'Coupons'),
        h('div', { style: { fontSize: 12, color: '#8c8c8c' } }, 'Generate discount codes with usage limits and validity dates, and record redemptions.')),
      h('div', { style: { display: 'flex', gap: 8 } },
        h(Button, { onClick: load }, 'Refresh'),
        h(Button, { onClick: () => setRedeemOpen(true), disabled: !coupons || !coupons.length }, 'Redeem'),
        h(Button, { type: 'primary', onClick: () => setFormFor({ coupon: null }) }, '+ Generate coupon'))),
    coupons === null ? h('div', { style: { textAlign: 'center', padding: 40 } }, h(Spin)) :
    coupons.length === 0 ? h(Empty, { image: Empty.PRESENTED_IMAGE_SIMPLE, description: 'No coupons yet. Generate your first one.' }) :
    h(Table, { rowKey: 'id', dataSource: coupons, columns, pagination: coupons.length > 20 ? { pageSize: 20 } : false, size: 'middle', scroll: { x: true } }),
    formFor && h(CouponFormModal, { open: !!formFor, onClose: () => setFormFor(null), coupon: formFor.coupon, services, onSaved: load }),
    h(RedeemModal, { open: redeemOpen, onClose: () => setRedeemOpen(false), coupons: coupons || [], usageByCoupon, onRedeemed: load }));
}

ctx.render(h(CouponsPanel));
