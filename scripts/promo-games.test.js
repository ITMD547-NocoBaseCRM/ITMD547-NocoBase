// Unit tests for the pure promo game logic (node --test scripts/promo-games.test.js).
const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  eligibleItems,
  gamesCollectionDefinition,
  itemsCollectionDefinition,
  pickWeighted,
  probabilities,
  spinsCollectionDefinition,
} = require('./promo-games');

const item = (id, patch = {}) => ({ id, label: 'i' + id, kind: 'win', weight: 1, winLimit: 0, ...patch });

describe('eligibleItems', () => {
  it('keeps win items under their limit and drops exhausted ones', () => {
    const items = [item(1, { winLimit: 2 }), item(2, { winLimit: 2 })];
    assert.deepStrictEqual(eligibleItems(items, { 1: 2, 2: 1 }).map((i) => i.id), [2]);
  });
  it('treats winLimit 0 as unlimited', () => {
    assert.strictEqual(eligibleItems([item(1)], { 1: 999 }).length, 1);
  });
  it('always keeps noWin segments', () => {
    const items = [item(1, { kind: 'noWin', winLimit: 1 })];
    assert.strictEqual(eligibleItems(items, { 1: 50 }).length, 1);
  });
  it('drops zero-weight segments', () => {
    assert.strictEqual(eligibleItems([item(1, { weight: 0 })]).length, 0);
  });
});

describe('pickWeighted', () => {
  it('returns null with no eligible weight', () => {
    assert.strictEqual(pickWeighted([]), null);
    assert.strictEqual(pickWeighted([item(1, { weight: 0 })]), null);
  });
  it('respects the random roll across weights', () => {
    const items = [item(1, { weight: 1 }), item(2, { weight: 3 })];
    assert.strictEqual(pickWeighted(items, () => 0.1).id, 1);   // 0.4 of 4 < 1
    assert.strictEqual(pickWeighted(items, () => 0.5).id, 2);   // 2 of 4 ≥ 1
    assert.strictEqual(pickWeighted(items, () => 0.999).id, 2);
  });
  it('is statistically proportional to the weights', () => {
    const items = [item(1, { weight: 1 }), item(2, { weight: 9 })];
    let wins = 0;
    let seed = 42;
    const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < 5000; i++) if (pickWeighted(items, rand).id === 2) wins++;
    assert.ok(wins > 4300 && wins < 4700, `expected ~4500 of 5000, got ${wins}`);
  });
});

describe('probabilities', () => {
  it('turns weights into percentages', () => {
    const p = probabilities([item(1, { weight: 1 }), item(2, { weight: 3 })]);
    assert.strictEqual(p[1], 25);
    assert.strictEqual(p[2], 75);
  });
  it('redistributes when a segment is excluded', () => {
    const items = [item(1, { weight: 1, winLimit: 1 }), item(2, { weight: 1 }), item(3, { kind: 'noWin', weight: 2 })];
    const p = probabilities(eligibleItems(items, { 1: 1 }));
    assert.strictEqual(p[1], undefined);
    assert.strictEqual(p[2], 33.3);
    assert.strictEqual(p[3], 66.7);
  });
});

describe('collection definitions', () => {
  it('items carry weight, winLimit, kind, coupon link and game link', () => {
    const def = itemsCollectionDefinition();
    for (const name of ['game', 'label', 'kind', 'weight', 'winLimit', 'coupon', 'color']) {
      assert.ok(def.fields.find((f) => f.name === name), `${name} should exist`);
    }
    assert.strictEqual(def.fields.find((f) => f.name === 'coupon').target, 'coupons');
    assert.strictEqual(def.fields.find((f) => f.name === 'weight').defaultValue, 1);
    assert.strictEqual(def.fields.find((f) => f.name === 'winLimit').defaultValue, 0);
  });
  it('spins record game, item, customer, email, time and won flag', () => {
    const def = spinsCollectionDefinition();
    for (const name of ['game', 'item', 'customer', 'email', 'spunAt', 'won']) {
      assert.ok(def.fields.find((f) => f.name === name), `${name} should exist`);
    }
  });
  it('games default to active and carry a unique public link token', () => {
    const def = gamesCollectionDefinition();
    assert.strictEqual(def.fields.find((f) => f.name === 'status').defaultValue, 'active');
    assert.strictEqual(def.fields.find((f) => f.name === 'publicToken').unique, true);
  });
});
