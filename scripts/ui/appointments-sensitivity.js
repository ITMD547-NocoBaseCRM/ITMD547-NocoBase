// Customer skin-sensitivity indicator for the Appointments page (US-26 / T-44).
//
// Runs inside NocoBase's JS field runtime, once per appointment row (variant 'cell') and once in the
// appointment details drawer (variant 'details'). It only READS what US-01 already stores on the customer
// (customers.skinSensitivities plus the free-text skinSensitivitiesOther) through the appointment's customer
// relation. Nothing is copied onto the appointment and nothing is requested: the row already carries its
// customer because the table appends the relation in its single list request, so there is no per-row fetch.
//
// Wording matters here. A customer with no record is "No sensitivities recorded", never "no sensitivities":
// an empty profile means nothing was captured, not that the customer has none.
//
// The variant placeholder below is filled in by scripts/appointments-page-blueprint.js.

const VARIANT = /*SENSITIVITY_VARIANT*/'cell';
const NONE = 'No sensitivities recorded';
const UNAVAILABLE = 'Sensitivity information not available';

const { React } = ctx.libs;
const { Popover } = ctx.libs.antd;
const { useState } = React;
const e = React.createElement;

const current = (await ctx.getVar('ctx.record')) || {};
const customer = current.customer;

// Labels come from the US-01 field metadata (the enum on customers.skinSensitivities), so the wording
// follows the schema; a stored value without a label is shown as is.
const labelByValue = {};
try {
  const customerCollection = ctx.dataSourceManager.getDataSource('main').collectionManager.getCollection('customers');
  const sensitivityField = customerCollection && customerCollection.getFields().find((f) => f.name === 'skinSensitivities');
  const options = (sensitivityField && (sensitivityField.enum || (sensitivityField.options && sensitivityField.options.enum) || (sensitivityField.uiSchema && sensitivityField.uiSchema.enum))) || [];
  options.forEach((o) => { labelByValue[o.value] = String(o.label == null ? o.value : o.label).replace(/^\{\{\s*t\(\s*["'](.*)["']\s*\)\s*\}\}$/, '$1'); });
} catch (err) { /* labels fall back to the stored values */ }

const has = (key) => !!customer && Object.prototype.hasOwnProperty.call(customer, key);
// Neither field present means the role cannot see them: say so instead of claiming "none recorded".
const unavailable = !customer || (!has('skinSensitivities') && !has('skinSensitivitiesOther'));
const values = Array.isArray(customer && customer.skinSensitivities) ? customer.skinSensitivities.filter((v) => typeof v === 'string' && v.trim() !== '') : [];
const otherText = String((customer && customer.skinSensitivitiesOther) || '').trim();
const entries = values.map((v) => (v === 'other' && otherText ? 'Other: ' + otherText : (labelByValue[v] || v)));
// Free text without the "Other" option ticked is still a recorded sensitivity; show it rather than hide it.
if (otherText && values.indexOf('other') < 0) entries.push('Other: ' + otherText);

// Amber, not red: a caution to notice, not an error. The shape and the words carry the meaning, not the colour.
const warnIcon = e('svg', { width: 14, height: 14, viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false', style: { flex: 'none' } },
  e('path', { d: 'M8 1.8 15 14H1L8 1.8z', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinejoin: 'round' }),
  e('path', { d: 'M8 6.2v4M8 11.9v.3', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }));
const muted = (text) => e('span', { style: { color: '#595959', fontSize: 12 } }, text);
const list = (items) => e('ul', { style: { margin: 0, paddingLeft: 18 } }, items.map((t, i) => e('li', { key: i }, t)));

function Cell() {
  const [open, setOpen] = useState(false);
  const accessibleName = 'Skin sensitivities recorded: ' + entries.join(', ') + '. Press to show details.';
  // Click opens the panel (mouse, touch and the Enter/Space keys on the button); Escape closes it. No hover is needed.
  const panel = e('div', { role: 'dialog', 'aria-label': 'Skin sensitivities recorded', style: { maxWidth: 280 } },
    e('div', { style: { fontWeight: 600, marginBottom: 4 } }, 'Skin sensitivities recorded'),
    list(entries),
    e('div', { style: { marginTop: 8, fontSize: 12, color: '#595959' } }, 'From the customer profile.'));
  const button = e('button', {
    type: 'button',
    'aria-label': accessibleName,
    'aria-haspopup': 'dialog',
    'aria-expanded': open,
    onKeyDown: (ev) => { if (ev.key === 'Escape') setOpen(false); },
    style: { display: 'inline-flex', alignItems: 'center', gap: 5, padding: '1px 8px', border: '1px solid #ffd666', borderRadius: 12, background: '#fffbe6', color: '#874d00', font: 'inherit', fontSize: 12, lineHeight: '20px', cursor: 'pointer', whiteSpace: 'nowrap' },
  }, warnIcon, e('span', null, 'Sensitivities'), e('span', { style: { fontWeight: 600 } }, String(entries.length)));
  return e(Popover, { open, onOpenChange: setOpen, trigger: 'click', placement: 'bottomLeft', content: panel, destroyTooltipOnHide: true }, button);
}

function Details() {
  return e('div', { role: 'group', 'aria-label': 'Skin sensitivities recorded', style: { display: 'inline-block', padding: '8px 12px', border: '1px solid #ffd666', borderRadius: 8, background: '#fffbe6', color: '#874d00' } },
    e('div', { style: { display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, marginBottom: 4 } }, warnIcon, 'Skin sensitivities recorded'),
    list(entries));
}

if (unavailable) ctx.render(muted(UNAVAILABLE));
else if (!entries.length) ctx.render(muted(NONE));
else ctx.render(e(VARIANT === 'details' ? Details : Cell));
