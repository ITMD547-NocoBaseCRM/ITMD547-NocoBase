// Unit tests for the pure coupon definitions (node --test scripts/coupons.test.js).
const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  CODE_ALPHABET,
  couponsCollectionDefinition,
  describeDiscount,
  generateCouponCode,
  redemptionsCollectionDefinition,
  validateCoupon,
} = require('./coupons');

describe('generateCouponCode', () => {
  it('produces PREFIX-XXXXXX with unambiguous characters', () => {
    for (let i = 0; i < 50; i++) {
      const code = generateCouponCode();
      assert.match(code, /^BW-[A-Z2-9]{6}$/);
      for (const ch of code.slice(3)) assert.ok(CODE_ALPHABET.includes(ch), `${ch} should be in the alphabet`);
    }
  });
  it('never contains ambiguous characters', () => {
    for (const bad of ['0', 'O', '1', 'I', 'L']) assert.ok(!CODE_ALPHABET.includes(bad));
  });
  it('honours prefix and length', () => {
    assert.match(generateCouponCode('SPRING', 4), /^SPRING-[A-Z2-9]{4}$/);
  });
});

describe('validateCoupon', () => {
  const base = { status: 'active', validFrom: null, validUntil: null, perCustomerLimit: 1, totalLimit: 10 };
  it('accepts an active coupon inside its window and limits', () => {
    assert.deepStrictEqual(validateCoupon({ ...base }, { totalRedemptions: 3, customerRedemptions: 0 }), { ok: true });
  });
  it('rejects a disabled coupon', () => {
    assert.strictEqual(validateCoupon({ ...base, status: 'disabled' }).ok, false);
  });
  it('rejects before validFrom and after validUntil', () => {
    const now = new Date('2026-06-15T12:00:00Z');
    assert.strictEqual(validateCoupon({ ...base, validFrom: '2026-07-01' }, { now }).ok, false);
    assert.strictEqual(validateCoupon({ ...base, validUntil: '2026-06-01' }, { now }).ok, false);
    assert.strictEqual(validateCoupon({ ...base, validFrom: '2026-06-01', validUntil: '2026-07-01' }, { now }).ok, true);
  });
  it('enforces the overall limit', () => {
    assert.strictEqual(validateCoupon({ ...base, totalLimit: 5 }, { totalRedemptions: 5 }).ok, false);
    assert.strictEqual(validateCoupon({ ...base, totalLimit: 5 }, { totalRedemptions: 4 }).ok, true);
  });
  it('enforces the per-customer limit', () => {
    assert.strictEqual(validateCoupon({ ...base, perCustomerLimit: 2 }, { customerRedemptions: 2 }).ok, false);
    assert.strictEqual(validateCoupon({ ...base, perCustomerLimit: 2 }, { customerRedemptions: 1 }).ok, true);
  });
  it('treats 0 limits as unlimited', () => {
    assert.strictEqual(validateCoupon({ ...base, totalLimit: 0, perCustomerLimit: 0 }, { totalRedemptions: 999, customerRedemptions: 99 }).ok, true);
  });
});

describe('describeDiscount', () => {
  it('formats percent and fixed discounts', () => {
    assert.strictEqual(describeDiscount({ discountType: 'percent', discountValue: 15 }), '15% off');
    assert.strictEqual(describeDiscount({ discountType: 'fixed', discountValue: 10 }), '$10 off');
    assert.strictEqual(describeDiscount({ discountType: 'fixed', discountValue: 7.5 }), '$7.50 off');
  });
});

describe('collection definitions', () => {
  const coupons = couponsCollectionDefinition();
  const redemptions = redemptionsCollectionDefinition();
  it('coupons has every required field', () => {
    for (const name of ['code', 'name', 'discountType', 'discountValue', 'appliesTo', 'service', 'validFrom', 'validUntil', 'perCustomerLimit', 'totalLimit', 'status']) {
      assert.ok(coupons.fields.find((f) => f.name === name), `${name} should exist`);
    }
  });
  it('code is unique', () => {
    assert.strictEqual(coupons.fields.find((f) => f.name === 'code').unique, true);
  });
  it('service targets services, scope options are all|service', () => {
    assert.strictEqual(coupons.fields.find((f) => f.name === 'service').target, 'services');
    assert.deepStrictEqual(coupons.fields.find((f) => f.name === 'appliesTo').uiSchema.enum.map((o) => o.value), ['all', 'service']);
  });
  it('sensible defaults: percent, all services, active, 1 per customer, unlimited overall', () => {
    assert.strictEqual(coupons.fields.find((f) => f.name === 'discountType').defaultValue, 'percent');
    assert.strictEqual(coupons.fields.find((f) => f.name === 'appliesTo').defaultValue, 'all');
    assert.strictEqual(coupons.fields.find((f) => f.name === 'status').defaultValue, 'active');
    assert.strictEqual(coupons.fields.find((f) => f.name === 'perCustomerLimit').defaultValue, 1);
    assert.strictEqual(coupons.fields.find((f) => f.name === 'totalLimit').defaultValue, 0);
  });
  it('redemptions links coupon and customer', () => {
    assert.strictEqual(redemptions.fields.find((f) => f.name === 'coupon').target, 'coupons');
    assert.strictEqual(redemptions.fields.find((f) => f.name === 'customer').target, 'customers');
    assert.ok(redemptions.fields.find((f) => f.name === 'redeemedAt'));
  });
});
