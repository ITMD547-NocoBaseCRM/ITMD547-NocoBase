// Behaviour tests for the customer sensitivity indicator (US-26 / T-44), run against the real script.
//
// The script runs inside NocoBase's JS field runtime. It is evaluated here with a stand-in for `ctx` that
// supplies the appointment row (with its customer relation already loaded) and the US-01 field metadata.
// The fake API records every request, so the tests can prove the indicator never fetches anything.

const test = require('node:test');
const assert = require('node:assert/strict');
const { installDom } = require('./test-support/jsdom-env');

installDom();

const React = require('react');
const antd = require('antd');
const { act, cleanup, fireEvent, render, screen, waitFor } = require('@testing-library/react');
const { readSensitivityScript } = require('./appointments-page-blueprint');

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// Same values and labels as the US-01 schema for customers.skinSensitivities.
const US01_ENUM = [
  { value: 'fragrancesPerfumes', label: 'Fragrances & Perfumes' },
  { value: 'essentialOils', label: 'Essential Oils' },
  { value: 'alphaHydroxyAcids', label: 'Alpha Hydroxy Acids (AHAs)' },
  { value: 'betaHydroxyAcidsSalicylicAcid', label: 'Beta Hydroxy Acids (BHAs) / Salicylic Acid' },
  { value: 'retinoidsRetinol', label: 'Retinoids / Retinol' },
  { value: 'latex', label: 'Latex' },
  { value: 'nutsSeedOils', label: 'Nuts & Seed Oils' },
  { value: 'sunExposureSunburn', label: 'Sun Exposure / Sunburn' },
  { value: 'other', label: 'Other' },
];

const NONE = 'No sensitivities recorded';
const UNAVAILABLE = 'Sensitivity information not available';

// Runs the script for one appointment row and renders what it passes to ctx.render().
async function mount({ customer, variant = 'cell', labels = US01_ENUM, row } = {}) {
  const requests = [];
  let element = null;
  const ctx = {
    libs: { React, antd },
    getVar: async (path) => (path === 'ctx.record' ? row ?? { id: 1, customer } : undefined),
    dataSourceManager: {
      getDataSource: () => ({
        collectionManager: {
          getCollection: (name) =>
            name === 'customers' ? { getFields: () => [{ name: 'skinSensitivities', enum: labels }] } : null,
        },
      }),
    },
    // Anything that could fetch data is recorded; the indicator must use none of it.
    api: { request: async (...args) => requests.push(['api.request', ...args]) },
    initResource: (...args) => requests.push(['initResource', ...args]),
    makeResource: (...args) => requests.push(['makeResource', ...args]),
    request: async (...args) => requests.push(['request', ...args]),
    render: (node) => {
      element = node;
    },
  };
  await new AsyncFunction('ctx', readSensitivityScript(variant))(ctx);
  const view = element ? render(element) : null;
  return { view, requests, rendered: element !== null, container: view ? view.container : null };
}

const triggerButton = () => screen.getByRole('button', { name: /Skin sensitivities recorded/ });
const settle = async (ms = 50) => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
};

test.afterEach(() => cleanup());

test('a customer with recorded sensitivities gets a labelled, accessible indicator', async () => {
  await mount({ customer: { skinSensitivities: ['fragrancesPerfumes', 'latex'], skinSensitivitiesOther: null } });

  const button = triggerButton();
  assert.equal(button.tagName, 'BUTTON', 'a real button, so Tab, Enter and Space work natively');
  assert.equal(button.getAttribute('type'), 'button');
  assert.equal(
    button.getAttribute('aria-label'),
    'Skin sensitivities recorded: Fragrances & Perfumes, Latex. Press to show details.',
    'the accessible name carries the full list, so a screen reader needs no hover',
  );
  assert.equal(button.getAttribute('aria-haspopup'), 'dialog');
  assert.equal(button.getAttribute('aria-expanded'), 'false');

  // visible words and a count, plus a decorative shape: the warning is not colour alone
  assert.match(button.textContent, /Sensitivities/);
  assert.match(button.textContent, /2$/);
  const icon = button.querySelector('svg');
  assert.ok(
    icon && icon.getAttribute('aria-hidden') === 'true',
    'the icon is decorative and hidden from screen readers',
  );
});

test('labels follow the US-01 field metadata; unknown stored values fall back to the raw value', async () => {
  await mount({
    customer: { skinSensitivities: ['latex', 'mysteryValue'] },
    labels: [{ value: 'latex', label: '{{t("Latex (custom label)")}}' }],
  });
  assert.equal(
    triggerButton().getAttribute('aria-label'),
    'Skin sensitivities recorded: Latex (custom label), mysteryValue. Press to show details.',
  );
});

test('click opens the details and Escape closes them; nothing depends on hover', async () => {
  await mount({ customer: { skinSensitivities: ['essentialOils', 'sunExposureSunburn'] } });
  const button = triggerButton();

  fireEvent.click(button); // what a tap, a mouse click and Enter/Space on a button all produce
  await waitFor(() => assert.equal(button.getAttribute('aria-expanded'), 'true'));
  const dialog = await screen.findByRole('dialog', { name: 'Skin sensitivities recorded' });
  const items = Array.from(dialog.querySelectorAll('li')).map((li) => li.textContent);
  assert.deepEqual(items, ['Essential Oils', 'Sun Exposure / Sunburn']);
  assert.match(dialog.textContent, /From the customer profile\./);

  fireEvent.keyDown(button, { key: 'Escape', code: 'Escape' });
  await waitFor(() => assert.equal(button.getAttribute('aria-expanded'), 'false'));

  // hovering alone never opens it
  fireEvent.mouseEnter(button);
  fireEvent.mouseOver(button);
  await settle(100);
  assert.equal(button.getAttribute('aria-expanded'), 'false');
});

test('"Other" shows the free text; free text without the Other option is not hidden; blanks are ignored', async () => {
  await mount({
    customer: { skinSensitivities: ['other', '  ', 'latex'], skinSensitivitiesOther: ' Botanical extract ' },
  });
  assert.equal(
    triggerButton().getAttribute('aria-label'),
    'Skin sensitivities recorded: Other: Botanical extract, Latex. Press to show details.',
  );
  cleanup();

  await mount({ customer: { skinSensitivities: ['latex'], skinSensitivitiesOther: 'Aloe' } });
  assert.equal(
    triggerButton().getAttribute('aria-label'),
    'Skin sensitivities recorded: Latex, Other: Aloe. Press to show details.',
  );
  cleanup();

  await mount({ customer: { skinSensitivities: null, skinSensitivitiesOther: 'Aloe' } });
  assert.equal(
    triggerButton().getAttribute('aria-label'),
    'Skin sensitivities recorded: Other: Aloe. Press to show details.',
  );
});

test('no record says "No sensitivities recorded" and never claims there are none', async () => {
  for (const customer of [
    { skinSensitivities: null, skinSensitivitiesOther: null },
    { skinSensitivities: [], skinSensitivitiesOther: '' },
    { skinSensitivities: ['  '], skinSensitivitiesOther: '   ' },
    { skinSensitivities: undefined, skinSensitivitiesOther: undefined },
  ]) {
    const { container } = await mount({ customer });
    assert.equal(container.textContent, NONE);
    assert.equal(screen.queryByRole('button'), null, 'no alert button when nothing is recorded');
    assert.ok(!/allerg/i.test(container.textContent));
    assert.ok(!/\bno sensitivities\b(?! recorded)/i.test(container.textContent), 'must not read as "no sensitivities"');
    cleanup();
  }
});

test('an unavailable customer is reported as unavailable, not as "none recorded"', async () => {
  for (const customer of [undefined, null, {}, { firstName: 'Ava' }]) {
    const { container } = await mount({ customer });
    assert.equal(container.textContent, UNAVAILABLE);
    assert.notEqual(container.textContent, NONE);
    cleanup();
  }
});

test('the details variant lists every sensitivity inline, with no popover to open', async () => {
  const { container } = await mount({
    variant: 'details',
    customer: { skinSensitivities: ['alphaHydroxyAcids', 'retinoidsRetinol', 'other'], skinSensitivitiesOther: 'Aloe' },
  });
  const group = screen.getByRole('group', { name: 'Skin sensitivities recorded' });
  assert.deepEqual(
    Array.from(group.querySelectorAll('li')).map((li) => li.textContent),
    ['Alpha Hydroxy Acids (AHAs)', 'Retinoids / Retinol', 'Other: Aloe'],
  );
  assert.match(group.textContent, /^Skin sensitivities recorded/, 'the words, not only the colour, state the warning');
  assert.equal(screen.queryByRole('button'), null);
  assert.equal(container.querySelector('svg').getAttribute('aria-hidden'), 'true');
  cleanup();

  const none = await mount({ variant: 'details', customer: { skinSensitivities: [] } });
  assert.equal(none.container.textContent, NONE);
});

test('the indicator never fetches data: the customer already arrived with the appointment row', async () => {
  const withSensitivity = await mount({ customer: { skinSensitivities: ['latex'] } });
  const without = await mount({ customer: { skinSensitivities: null } });
  const unavailable = await mount({ customer: undefined });
  const details = await mount({ variant: 'details', customer: { skinSensitivities: ['latex'] } });
  for (const result of [withSensitivity, without, unavailable, details]) {
    assert.deepEqual(result.requests, [], 'a per-row request would be an N+1 against the customers resource');
  }
});

test('the script is a render surface that only reads the host record through ctx', () => {
  const code = readSensitivityScript('cell');
  assert.ok(!code.includes('/*SENSITIVITY_VARIANT*/'), 'the variant placeholder must be replaced');
  assert.match(code, /const VARIANT = 'cell';/);
  assert.match(readSensitivityScript('details'), /const VARIANT = 'details';/);
  assert.ok(code.includes("await ctx.getVar('ctx.record')"), 'the host record is read through ctx.getVar');
  assert.ok(code.includes('ctx.render('), 'a render surface must call ctx.render');
  // data access and browser globals the RunJS validator or the N+1 rule would object to
  for (const forbidden of [
    'ctx.api',
    'ctx.request',
    'ctx.initResource',
    'ctx.makeResource',
    'fetch(',
    'XMLHttpRequest',
    'document.',
    'window.',
    'URLSearchParams',
  ]) {
    assert.ok(!code.includes(forbidden), `the indicator must not use ${forbidden}`);
  }
  assert.throws(() => readSensitivityScript('compact'), /Unknown sensitivity variant/);
});
