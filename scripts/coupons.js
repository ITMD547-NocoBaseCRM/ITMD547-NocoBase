// Coupons: pure definitions of what is applied to NocoBase (unit-tested; no network here).
//
// Two collections:
//   1. `coupons` — one row per coupon code: discount (percent or fixed amount), scope (all
//      services or one particular service), validity window, per-customer limit, overall limit,
//      and an active/disabled switch.
//   2. `couponRedemptions` — one row each time a coupon is redeemed for a customer. The limits
//      are enforced by counting these rows at redemption time (validateCoupon below).
//
// The Coupons tab on the Messages page (scripts/ui/coupons-tab.js) generates codes, lists
// coupons with usage, and records redemptions. Applied by scripts/apply-coupons.js.

const COUPONS_COLLECTION = 'coupons';
const REDEMPTIONS_COLLECTION = 'couponRedemptions';
const COUPONS_TAB_TITLE = 'Coupons';

// Unambiguous alphabet (no 0/O, 1/I/L) so codes survive handwriting and phone calls.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function generateCouponCode(prefix = 'BW', length = 6, random = Math.random) {
  let out = '';
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)];
  return `${prefix}-${out}`;
}

// Pure validation used by the redeem dialog. `coupon` is the coupons row;
// `totalRedemptions` / `customerRedemptions` are counts of couponRedemptions rows.
// Limits of 0 or null mean unlimited. Returns { ok: true } or { ok: false, reason }.
function validateCoupon(coupon, { now = new Date(), totalRedemptions = 0, customerRedemptions = 0 } = {}) {
  if (!coupon) return { ok: false, reason: 'Coupon not found.' };
  if (coupon.status !== 'active') return { ok: false, reason: 'This coupon is disabled.' };
  if (coupon.validFrom && now < new Date(coupon.validFrom)) return { ok: false, reason: 'This coupon is not valid yet.' };
  if (coupon.validUntil && now > new Date(coupon.validUntil)) return { ok: false, reason: 'This coupon has expired.' };
  if (coupon.totalLimit && totalRedemptions >= coupon.totalLimit) return { ok: false, reason: 'This coupon has reached its overall usage limit.' };
  if (coupon.perCustomerLimit && customerRedemptions >= coupon.perCustomerLimit) return { ok: false, reason: 'This customer has already used this coupon the maximum number of times.' };
  return { ok: true };
}

// Human description of the discount, e.g. "15% off" or "$10 off".
function describeDiscount(coupon) {
  if (!coupon) return '';
  return coupon.discountType === 'fixed'
    ? `$${Number(coupon.discountValue || 0).toFixed(2).replace(/\.00$/, '')} off`
    : `${Number(coupon.discountValue || 0)}% off`;
}

// ─── Collection definitions ──────────────────────────────────────────────────

const select = (name, title, options, defaultValue) => ({
  name,
  type: 'string',
  interface: 'select',
  ...(defaultValue !== undefined ? { defaultValue } : {}),
  uiSchema: { type: 'string', title, 'x-component': 'Select', enum: options },
});

const datetime = (name, title) => ({
  name,
  type: 'date',
  interface: 'datetime',
  uiSchema: { type: 'string', title, 'x-component': 'DatePicker', 'x-component-props': { showTime: true, utc: true } },
});

const integer = (name, title, defaultValue) => ({
  name,
  type: 'integer',
  interface: 'integer',
  ...(defaultValue !== undefined ? { defaultValue } : {}),
  uiSchema: { type: 'number', title, 'x-component': 'InputNumber', 'x-component-props': { min: 0, precision: 0 } },
});

function couponsCollectionDefinition() {
  return {
    name: COUPONS_COLLECTION,
    title: 'Coupons',
    template: 'general',
    logging: true,
    createdBy: true,
    updatedBy: true,
    createdAt: true,
    updatedAt: true,
    description: 'Discount coupons: code, percent or fixed discount, scope (all services or one service), validity window, per-customer and overall limits. Usage is tracked in couponRedemptions.',
    fields: [
      { name: 'code', type: 'string', unique: true, interface: 'input', uiSchema: { type: 'string', title: 'Code', 'x-component': 'Input' } },
      { name: 'name', type: 'string', interface: 'input', uiSchema: { type: 'string', title: 'Campaign name', 'x-component': 'Input' } },
      select('discountType', 'Discount type', [
        { value: 'percent', label: 'Percent (%)' },
        { value: 'fixed', label: 'Fixed amount ($)' },
      ], 'percent'),
      { name: 'discountValue', type: 'double', interface: 'number', uiSchema: { type: 'number', title: 'Discount value', 'x-component': 'InputNumber', 'x-component-props': { min: 0 } } },
      select('appliesTo', 'Applies to', [
        { value: 'all', label: 'All services' },
        { value: 'service', label: 'A particular service' },
      ], 'all'),
      {
        name: 'service',
        type: 'belongsTo',
        interface: 'm2o',
        target: 'services',
        foreignKey: 'serviceId',
        uiSchema: {
          type: 'object',
          title: 'Service',
          'x-component': 'AssociationField',
          'x-component-props': { multiple: false, fieldNames: { value: 'id', label: 'name' } },
        },
      },
      datetime('validFrom', 'Valid from'),
      datetime('validUntil', 'Valid until'),
      integer('perCustomerLimit', 'Limit per customer (0 = unlimited)', 1),
      integer('totalLimit', 'Overall limit (0 = unlimited)', 0),
      select('status', 'Status', [
        { value: 'active', label: 'Active' },
        { value: 'disabled', label: 'Disabled' },
      ], 'active'),
    ],
  };
}

function redemptionsCollectionDefinition() {
  return {
    name: REDEMPTIONS_COLLECTION,
    title: 'Coupon redemptions',
    template: 'general',
    logging: true,
    createdBy: true,
    updatedBy: true,
    createdAt: true,
    updatedAt: true,
    description: 'One row per coupon redemption: which coupon, which customer, when. Counted to enforce per-customer and overall limits.',
    fields: [
      {
        name: 'coupon',
        type: 'belongsTo',
        interface: 'm2o',
        target: COUPONS_COLLECTION,
        foreignKey: 'couponId',
        uiSchema: {
          type: 'object',
          title: 'Coupon',
          'x-component': 'AssociationField',
          'x-component-props': { multiple: false, fieldNames: { value: 'id', label: 'code' } },
        },
      },
      {
        name: 'customer',
        type: 'belongsTo',
        interface: 'm2o',
        target: 'customers',
        foreignKey: 'customerId',
        uiSchema: {
          type: 'object',
          title: 'Customer',
          'x-component': 'AssociationField',
          'x-component-props': { multiple: false, fieldNames: { value: 'id', label: 'firstName' } },
        },
      },
      datetime('redeemedAt', 'Redeemed at'),
      { name: 'note', type: 'string', interface: 'input', uiSchema: { type: 'string', title: 'Note', 'x-component': 'Input' } },
    ],
  };
}

module.exports = {
  CODE_ALPHABET,
  COUPONS_COLLECTION,
  COUPONS_TAB_TITLE,
  REDEMPTIONS_COLLECTION,
  couponsCollectionDefinition,
  describeDiscount,
  generateCouponCode,
  redemptionsCollectionDefinition,
  validateCoupon,
};
