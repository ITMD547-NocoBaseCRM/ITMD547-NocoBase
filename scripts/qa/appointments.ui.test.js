// Browser tests for appointment management (US-26 / T-46): the responsive matrix and the user journeys.
//
// Needs a running local NocoBase app and a Chromium (see support/browser.js); every test skips with a reason otherwise.
// Test rows use dates in March 2027 so they sort to the top of the table and are removed afterwards.
// Run with: yarn test:appointments-qa-ui

const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { qaUiTest } = require('./support/harness');
const { clippedText, controlsOutsideViewport, pageOverflow } = require('./support/layout-checks');
const { count, qaDate, qaTime, rows, body } = require('./support/fixtures');
const {
  closeDrawer,
  closePopup,
  fillForm,
  lastDrawer,
  openAppointments,
  openDrawer,
  openPopup,
  pickOption,
  rowCount,
  rowsOnDate,
  sleep,
  submit,
  tab,
  tabCounts,
  toastText,
  waitForRows,
} = require('./support/ui');

// On phones the table's actions are icon-only (the visible text is gone and the button carries only a title).
const newAppointment = (page) =>
  page.locator('button:has-text("New appointment"), button[title="New appointment"]').first();

const SHOTS = path.join(os.tmpdir(), 'appointments-qa-shots');
fs.mkdirSync(SHOTS, { recursive: true });
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, name) }).catch(() => {});
const encode = (value) => encodeURIComponent(JSON.stringify(value));

async function seedRows({ world, reference }) {
  const withAlert = await world.createAppointment({
    customerId: reference.shapes.multiple[0].id,
    staffId: reference.staff[0].id,
    appointmentDate: qaDate(20),
    startTime: qaTime(20, 10),
    endTime: qaTime(20, 11),
    appointmentServices: [{ serviceId: reference.services[0].id, priceAtBooking: 42, durationAtBooking: 30 }],
  });
  const noAlert = await world.createAppointment({
    customerId: reference.shapes.none[0].id,
    appointmentDate: qaDate(19),
    startTime: qaTime(19, 10),
  });
  return { withAlert: withAlert.id, noAlert: noAlert.id };
}

// -------------------------------------------------------------------------------------------------------------
// Responsive matrix. 375px is the required acceptance viewport.
// -------------------------------------------------------------------------------------------------------------

const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
  { width: 768, height: 1024 },
  { width: 430, height: 932, touch: true },
  { width: 390, height: 844, touch: true },
  { width: 375, height: 812, touch: true },
];

// A popup is a drawer on wide screens and a full page on phones; either must fit the screen without sideways scrolling.
async function assertPopupFits(page, viewport, label, mode) {
  if (mode === 'drawer') {
    const wrapper = page.locator('.ant-drawer-content-wrapper').last();
    const box = await wrapper.boundingBox();
    assert.ok(
      box && box.x >= -1 && box.x + box.width <= viewport.width + 1,
      `${label}: the drawer is wider than the screen ${JSON.stringify(box)}`,
    );
    const body = await lastDrawer(page)
      .locator('.ant-drawer-body')
      .evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
    assert.ok(
      body.scroll <= body.client + 1,
      `${label}: the drawer scrolls sideways (${body.scroll} > ${body.client})`,
    );
  }
  const root = mode === 'drawer' ? '.ant-drawer-content' : 'body';
  const overflow = await pageOverflow(page, root);
  assert.ok(
    overflow.documentScrollWidth <= overflow.innerWidth + 1,
    `${label}: the page scrolls sideways (${overflow.documentScrollWidth} > ${overflow.innerWidth})`,
  );
  assert.deepEqual(overflow.offenders, [], `${label}: content sticks out of the screen`);
  assert.deepEqual(await clippedText(page, root), [], `${label}: clipped text`);
}

for (const viewport of VIEWPORTS) {
  qaUiTest(
    `responsive ${viewport.width}px: page, tabs, toolbar, table actions, drawers, delete confirmation and sensitivity panel fit`,
    async (ctx) => {
      await seedRows(ctx);
      const { context, page, pageErrors } = await openAppointments(ctx.browser, { viewport, touch: !!viewport.touch });
      try {
        await waitForRows(page);
        await shot(page, `${viewport.width}-page.png`);

        // page: no sideways scrolling, nothing sticking out
        const overflow = await pageOverflow(page);
        assert.ok(
          overflow.documentScrollWidth <= overflow.innerWidth + 1,
          `the page scrolls sideways (${overflow.documentScrollWidth} > ${overflow.innerWidth})`,
        );
        assert.deepEqual(overflow.offenders, [], 'elements stick out past the right edge');

        // tabs and toolbar
        await page.evaluate(() => {
          let node = document.querySelector('[role=tablist]');
          while (node && !node.querySelector('input[placeholder^="Search customer"]')) node = node.parentElement;
          if (node) node.setAttribute('data-qa-toolbar', '1');
        });
        for (const name of ['All', 'Sessions', 'Events']) {
          const box = await tab(page, name).boundingBox();
          assert.ok(
            box && box.x >= 0 && box.x + box.width <= viewport.width,
            `the ${name} tab is cut off ${JSON.stringify(box)}`,
          );
        }
        assert.deepEqual(await clippedText(page, '[data-qa-toolbar]'), [], 'text is clipped in the toolbar');
        assert.deepEqual(
          await controlsOutsideViewport(page, '[data-qa-toolbar]'),
          [],
          'toolbar controls are outside the screen',
        );

        // table: actions reachable. The table may scroll inside its own box, but View must be usable.
        const alertRow = rowsOnDate(page, 20).first();
        await alertRow.scrollIntoViewIfNeeded();
        const view = alertRow.getByText('View', { exact: true });
        const viewBox = await view.boundingBox();
        assert.ok(
          viewBox && viewBox.x >= 0 && viewBox.x + viewBox.width <= viewport.width,
          `View is not reachable ${JSON.stringify(viewBox)}`,
        );

        // sensitivity panel
        const indicator = alertRow.getByRole('button', { name: /Skin sensitivities recorded/ });
        await indicator.scrollIntoViewIfNeeded();
        await indicator.click();
        const panel = page.getByRole('dialog', { name: 'Skin sensitivities recorded' });
        await panel.waitFor({ timeout: 5000 });
        await sleep(700);
        const panelBox = await panel.boundingBox();
        assert.ok(
          panelBox && panelBox.width > 50 && panelBox.x >= 0 && panelBox.x + panelBox.width <= viewport.width + 1,
          `the sensitivity panel does not fit ${JSON.stringify(panelBox)}`,
        );
        await page.keyboard.press('Escape');
        await sleep(400);

        // details popup
        let popup = await openPopup(page, rowsOnDate(page, 20).first().getByText('View', { exact: true }));
        await assertPopupFits(page, viewport, 'View', popup.mode);
        assert.match(await popup.scope.innerText(), /Skin sensitivities recorded/);
        await shot(page, `${viewport.width}-view.png`);
        await closePopup(page, popup.mode);

        // edit form (the services sub-table makes it the widest content)
        popup = await openPopup(page, rowsOnDate(page, 20).first().getByText('Edit', { exact: true }));
        await assertPopupFits(page, viewport, 'Edit', popup.mode);
        const submitButton = popup.scope.getByRole('button', { name: 'Submit' });
        await submitButton.scrollIntoViewIfNeeded();
        const submitBox = await submitButton.boundingBox();
        assert.ok(
          submitBox && submitBox.x >= 0 && submitBox.x + submitBox.width <= viewport.width,
          `Submit is not reachable ${JSON.stringify(submitBox)}`,
        );
        const table = await popup.scope.locator('.ant-table-container').first().boundingBox();
        assert.ok(
          !table || (table.x >= 0 && table.x + table.width <= viewport.width + 1),
          `the services sub-table is wider than the screen ${JSON.stringify(table)}`,
        );
        const footer = await page.evaluate(() => {
          const wrapper = Array.from(document.querySelectorAll('.ant-form .ant-table-wrapper')).pop();
          const footerEl = wrapper && wrapper.querySelector('.ant-table-footer');
          const pagerEl = wrapper && wrapper.querySelector('.ant-pagination');
          if (!footerEl || !pagerEl) return null;
          return {
            footerBottom: footerEl.getBoundingClientRect().bottom,
            pagerTop: pagerEl.getBoundingClientRect().top,
          };
        });
        assert.ok(footer, 'the services sub-table should have a footer and a pager');
        assert.ok(
          footer.pagerTop >= footer.footerBottom - 1,
          `the sub-table pager overlaps "Add new" and "Select record" ${JSON.stringify(footer)}`,
        );
        await shot(page, `${viewport.width}-edit.png`);
        await closePopup(page, popup.mode);

        // create form
        popup = await openPopup(page, newAppointment(page));
        await assertPopupFits(page, viewport, 'New appointment', popup.mode);
        const createSubmit = popup.scope.getByRole('button', { name: 'Submit' });
        await createSubmit.scrollIntoViewIfNeeded();
        const createBox = await createSubmit.boundingBox();
        assert.ok(
          createBox && createBox.x >= 0 && createBox.x + createBox.width <= viewport.width,
          'Submit is not reachable in the create form',
        );
        await shot(page, `${viewport.width}-create.png`);
        await closePopup(page, popup.mode);

        // delete asks first, fits, and Cancel keeps the row
        const cancelRow = rowsOnDate(page, 19).first();
        await cancelRow.scrollIntoViewIfNeeded();
        await cancelRow.getByText('Delete', { exact: true }).click();
        const confirm = page.locator('.ant-popconfirm:visible, .ant-modal:visible').first();
        await confirm.waitFor({ timeout: 5000 });
        await sleep(500);
        const confirmBox = await confirm.boundingBox();
        assert.ok(
          confirmBox && confirmBox.x >= 0 && confirmBox.x + confirmBox.width <= viewport.width + 1,
          `the delete confirmation does not fit ${JSON.stringify(confirmBox)}`,
        );
        await shot(page, `${viewport.width}-delete.png`);
        await confirm.getByRole('button', { name: 'Cancel' }).click();
        await sleep(800);
        assert.equal(await rowsOnDate(page, 19).count(), 1, 'Cancel must keep the appointment');

        assert.deepEqual(pageErrors, [], 'the page raised script errors');
      } finally {
        await context.close();
      }
    },
  );
}

// -------------------------------------------------------------------------------------------------------------
// Create, update, delete through the screens, and what the tabs do meanwhile
// -------------------------------------------------------------------------------------------------------------

qaUiTest(
  'journey: create an Event, see it under Events, move it to Sessions by editing, delete it with a confirmation',
  async (ctx) => {
    const { context, page } = await openAppointments(ctx.browser, { viewport: { width: 1280, height: 900 } });
    try {
      await waitForRows(page);
      const base = await tabCounts(page);

      await tab(page, 'Sessions').click();
      await sleep(2000);
      await newAppointment(page).click();
      const drawer = lastDrawer(page);
      await drawer.waitFor({ timeout: 30000 });
      await sleep(2500);
      await fillForm(page, drawer, { category: 'Event', day: 18 });
      await submit(page, drawer);
      assert.equal(
        await page.locator('.ant-drawer-content:visible').count(),
        0,
        'the drawer closes after a successful save',
      );

      let counts = await tabCounts(page);
      assert.deepEqual(
        counts,
        { All: base.All + 1, Sessions: base.Sessions, Events: base.Events + 1 },
        'the new Event updates the counts without a reload',
      );
      assert.equal(await rowsOnDate(page, 18).count(), 0, 'an Event does not show under Sessions');

      await tab(page, 'Events').click();
      await sleep(2500);
      assert.equal(await rowsOnDate(page, 18).count(), 1, 'the Event shows under Events');

      const editDrawer = await openDrawer(page, rowsOnDate(page, 18), 'Edit');
      await pickOption(page, editDrawer.locator('.ant-select').nth(1), 'Session');
      await submit(page, editDrawer);
      assert.equal(await rowsOnDate(page, 18).count(), 0, 'after the category change the record leaves Events');
      counts = await tabCounts(page);
      assert.deepEqual(
        counts,
        { All: base.All + 1, Sessions: base.Sessions + 1, Events: base.Events },
        'the count moves with the record',
      );

      await tab(page, 'Sessions').click();
      await sleep(2500);
      const row = rowsOnDate(page, 18);
      assert.equal(await row.count(), 1);
      await row.first().getByText('Delete', { exact: true }).click();
      const confirm = page.locator('.ant-popconfirm:visible, .ant-modal:visible').first();
      await confirm.waitFor({ timeout: 5000 });
      assert.match(await confirm.innerText(), /Delete appointment/);
      await confirm.getByRole('button', { name: 'Cancel' }).click();
      await sleep(800);
      assert.equal(await rowsOnDate(page, 18).count(), 1, 'Cancel keeps it');
      await row.first().getByText('Delete', { exact: true }).click();
      await page
        .locator('.ant-popconfirm:visible, .ant-modal:visible')
        .first()
        .getByRole('button', { name: /Confirm|OK/ })
        .click();
      await sleep(3500);
      assert.equal(await rowsOnDate(page, 18).count(), 0, 'the deleted appointment disappears');
      assert.deepEqual(await tabCounts(page), base, 'the counts return to where they started');
    } finally {
      await context.close();
    }
  },
);

qaUiTest('update: customer, technician, status and booked services can be edited from the form', async (ctx) => {
  const { root, world, reference } = ctx;
  const service = reference.services[0];
  const { id: created } = await world.createAppointment({
    customerId: reference.customers[0].id,
    staffId: reference.staff[0].id,
    appointmentDate: qaDate(21),
    startTime: qaTime(21, 10),
    appointmentServices: [{ serviceId: service.id, priceAtBooking: 40, durationAtBooking: 30 }],
  });
  const { context, page } = await openAppointments(ctx.browser, { viewport: { width: 1280, height: 900 } });
  try {
    await waitForRows(page);
    const drawer = await openDrawer(page, rowsOnDate(page, 21), 'Edit');
    const values = await drawer.locator('input').evaluateAll((inputs) => inputs.map((input) => input.value));
    assert.ok(values.includes('40'), 'the existing booked service line is shown with its price');

    await pickOption(page, drawer.locator('.ant-select').nth(0), reference.customers[1].firstName);
    await pickOption(page, drawer.locator('.ant-select').nth(2), `${reference.staff[1].firstName}`);
    await pickOption(page, drawer.locator('.ant-select').nth(3), 'Confirmed');
    const price = drawer
      .locator('input')
      .filter({ has: page.locator('xpath=self::*') })
      .evaluateAll((inputs) => inputs.findIndex((input) => input.value === '40'));
    const priceInput = drawer.locator('input').nth(await price);
    await priceInput.fill('55');
    await submit(page, drawer);

    const stored = body(
      await root.request(
        `appointments:get?filterByTk=${created}&appends[]=customer&appends[]=staff&appends[]=appointmentServices`,
      ),
    ).data;
    assert.equal(String(stored.customer.id), String(reference.customers[1].id), 'the customer changed');
    assert.equal(String(stored.staff.id), String(reference.staff[1].id), 'the technician changed');
    assert.equal(stored.status, 'confirmed', 'the status changed');
    assert.equal(stored.appointmentServices.length, 1);
    assert.equal(stored.appointmentServices[0].priceAtBooking, 55, 'the booked service price changed');
  } finally {
    await context.close();
  }
});

qaUiTest('update: removing a booked service in the form deletes it and leaves no orphan row', async (ctx) => {
  const { root, world, reference } = ctx;
  const [serviceA, serviceB] = reference.services;
  const { id: created } = await world.createAppointment({
    customerId: reference.customers[0].id,
    appointmentDate: qaDate(22),
    startTime: qaTime(22, 10),
    appointmentServices: [
      { serviceId: serviceA.id, priceAtBooking: 10, durationAtBooking: 30 },
      { serviceId: serviceB.id, priceAtBooking: 20, durationAtBooking: 45 },
    ],
  });
  const orphans = async () =>
    count(
      await root.request(`appointmentServices:list?pageSize=1&filter=${encode({ appointmentId: { $empty: true } })}`),
    );
  const orphansBefore = await orphans();
  const { context, page } = await openAppointments(ctx.browser, { viewport: { width: 1280, height: 900 } });
  try {
    await waitForRows(page);
    const drawer = await openDrawer(page, rowsOnDate(page, 22), 'Edit');
    const subTableRows = drawer.locator('.ant-table-tbody tr.ant-table-row');
    assert.equal(await subTableRows.count(), 2, 'both booked services are listed');
    await subTableRows.first().locator('.ant-table-cell-fix-right .anticon').last().click();
    await sleep(500);
    await submit(page, drawer);
    const lines = rows(
      await root.request(
        `appointmentServices:list?paginate=false&filter=${encode({ appointmentId: { $eq: created } })}`,
      ),
    );
    assert.equal(lines.length, 1, 'one line remains');
    assert.equal(await orphans(), orphansBefore, 'the removed line was deleted, not detached');
  } finally {
    await context.close();
  }
});

// -------------------------------------------------------------------------------------------------------------
// Validation and errors
// -------------------------------------------------------------------------------------------------------------

qaUiTest('validation: required fields are flagged, the form stays open and nothing is sent', async (ctx) => {
  const { context, page, requests } = await openAppointments(ctx.browser, { viewport: { width: 1280, height: 900 } });
  try {
    await waitForRows(page);
    await newAppointment(page).click();
    const drawer = lastDrawer(page);
    await drawer.waitFor({ timeout: 30000 });
    await sleep(2500);
    const before = requests.length;
    await drawer.getByRole('button', { name: 'Submit' }).click();
    await sleep(1500);
    const messages = await drawer.locator('.ant-form-item-explain-error').allInnerTexts();
    assert.ok(messages.length >= 2, `customer and start time must each be flagged (got ${JSON.stringify(messages)})`);
    for (const label of ['Customer', 'Start time']) {
      assert.ok(await drawer.locator('.ant-form-item-has-error', { hasText: label }).count(), `${label} is flagged`);
    }
    // the date is created from the start time, so it is not asked for
    assert.equal(
      await drawer.locator('.ant-form-item', { hasText: 'Appointment date' }).count(),
      0,
      'the form does not ask for a date',
    );
    assert.equal(await page.locator('.ant-drawer-content:visible').count(), 1, 'the drawer stays open');
    assert.equal(
      requests.slice(before).filter((request) => /appointments:create/.test(request.url)).length,
      0,
      'an incomplete form is not sent',
    );
    // the labels carry the required marker
    for (const label of ['Customer', 'Category', 'Start time', 'Status']) {
      assert.ok(
        await drawer.locator('.ant-form-item-required', { hasText: label }).count(),
        `${label} is marked required`,
      );
    }
  } finally {
    await context.close();
  }
});

qaUiTest(
  'validation: an end time before the start time is refused with a readable message, and nothing is stored',
  async (ctx) => {
    const { root } = ctx;
    const { context, page } = await openAppointments(ctx.browser, { viewport: { width: 1280, height: 900 } });
    try {
      await waitForRows(page);
      await newAppointment(page).click();
      const drawer = lastDrawer(page);
      await drawer.waitFor({ timeout: 30000 });
      await sleep(2500);
      await fillForm(page, drawer, { day: 23, time: '10:00:00', endTime: '09:00:00' });
      await drawer.getByRole('button', { name: 'Submit' }).click();
      await sleep(3000);
      const saved = count(
        await root.request(`appointments:list?pageSize=1&filter=${encode({ appointmentDate: { $eq: qaDate(23) } })}`),
      );
      assert.equal(saved, 0, 'an appointment that ends before it starts must not be stored');
      assert.equal(
        await page.locator('.ant-drawer-content:visible').count(),
        1,
        'the drawer stays open so the user can correct it',
      );
      const shown =
        (await toastText(page)) +
        ' ' +
        (await drawer.locator('.ant-form-item-explain-error').allInnerTexts()).join(' ');
      assert.ok(shown.trim().length > 0, 'the user is told that the save failed');
      assert.match(shown, /end time must be after the start time/i, 'the message says what is wrong');
      assert.ok(
        !/check constraint|violates|appointments_end_after_start|relation "/i.test(shown),
        `the message exposes database internals: ${shown.trim().slice(0, 160)}`,
      );
    } finally {
      await context.close();
    }
  },
);

qaUiTest(
  'errors: a failing create, delete and list are reported and do not lose data or crash the page',
  async (ctx) => {
    const { world, reference } = ctx;
    await world.createAppointment({
      customerId: reference.customers[0].id,
      appointmentDate: qaDate(24),
      startTime: qaTime(24, 10),
    });
    const failing = new Set();
    const { context, page, pageErrors } = await openAppointments(ctx.browser, {
      viewport: { width: 1280, height: 900 },
      route: async (p) => {
        await p.route(/\/api\/appointments:(create|destroy)/, (route) => {
          if (failing.has('write'))
            return route.fulfill({
              status: 500,
              contentType: 'application/json',
              body: JSON.stringify({ errors: [{ message: 'Simulated server failure' }] }),
            });
          return route.continue();
        });
      },
    });
    try {
      await waitForRows(page);
      failing.add('write');

      // delete fails: the row stays and the user is told
      const row = rowsOnDate(page, 24);
      await row.first().getByText('Delete', { exact: true }).click();
      await page
        .locator('.ant-popconfirm:visible, .ant-modal:visible')
        .first()
        .getByRole('button', { name: /Confirm|OK/ })
        .click();
      await sleep(2500);
      assert.equal(await rowsOnDate(page, 24).count(), 1, 'a failed delete leaves the appointment in place');
      assert.ok((await toastText(page)).trim().length > 0, 'a failed delete is reported to the user');

      // create fails: the drawer stays open with what the user typed
      await newAppointment(page).click();
      const drawer = lastDrawer(page);
      await drawer.waitFor({ timeout: 30000 });
      await sleep(2500);
      await fillForm(page, drawer, { day: 25 });
      await drawer.getByRole('button', { name: 'Submit' }).click();
      await sleep(2500);
      assert.equal(await page.locator('.ant-drawer-content:visible').count(), 1, 'a failed save keeps the form open');
      assert.match(
        await drawer.locator('.ant-picker input').first().inputValue(),
        new RegExp(qaDate(25)),
        'and keeps what was typed',
      );
      assert.ok((await toastText(page)).trim().length > 0, 'a failed save is reported');
      assert.deepEqual(pageErrors, [], 'the page raised script errors');
    } finally {
      await context.close();
    }
  },
);

const listOutage = (state) => async (p) => {
  await p.route(
    (url) => url.pathname.endsWith('/appointments:list') && !/pageSize=1(&|$)/.test(url.search),
    (route) => {
      if (state.fail) {
        return route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ errors: [{ message: 'Simulated outage' }] }),
        });
      }
      return route.continue();
    },
  );
};

qaUiTest(
  'errors: when the list cannot be loaded the page keeps working and loads again after a reload',
  async (ctx) => {
    const outage = { fail: true };
    const { context, page, pageErrors } = await openAppointments(ctx.browser, {
      viewport: { width: 1280, height: 900 },
      route: listOutage(outage),
    });
    try {
      await page.waitForSelector('[role=tablist]', { timeout: 90000 });
      await sleep(4000);
      assert.equal(await rowCount(page), 0, 'no rows are shown while the list fails');
      assert.equal(await tab(page, 'All').count(), 1, 'the toolbar and its counts keep working');
      // the platform rethrows the failed request itself; anything else would be a script error of ours
      const unexpected = pageErrors.filter((message) => !String(message).includes('Simulated outage'));
      assert.deepEqual(unexpected, [], 'a failed list must not raise script errors');
      outage.fail = false;
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('tr.ant-table-row', { timeout: 90000 });
      assert.ok((await rowCount(page)) > 0, 'rows load again once the service recovers');
    } finally {
      await context.close();
    }
  },
);

qaUiTest(
  'errors: a failed list shows a readable message with a way to retry, not an internals error',
  async (ctx) => {
    const outage = { fail: true };
    const { context, page } = await openAppointments(ctx.browser, {
      viewport: { width: 1280, height: 900 },
      route: listOutage(outage),
    });
    try {
      await page.waitForSelector('[role=tablist]', { timeout: 90000 });
      await sleep(4000);
      const text = await page.locator('body').innerText();
      assert.ok(
        !/NocoBase internals|Render failed/i.test(text),
        'the page shows the platform "Render failed ... internals bug" box',
      );
      assert.ok(
        (await newAppointment(page).count()) > 0,
        'the table actions (including New appointment) are still available',
      );
      assert.ok(
        (await page.getByRole('button', { name: /Refresh|Retry|Try again/ }).count()) > 0,
        'there is a way to retry',
      );
    } finally {
      await context.close();
    }
  },
  { todo: 'PLATFORM-GAP: NocoBase replaces a table whose list request fails with its "Render failed" error box' },
);

qaUiTest('loading: a slow list shows a loading state and the rows appear when it arrives', async (ctx) => {
  const { context, page } = await openAppointments(ctx.browser, {
    viewport: { width: 1280, height: 900 },
    route: async (p) => {
      await p.route(/\/api\/appointments:list(?!.*pageSize=1)/, async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 4000));
        await route.continue();
      });
    },
  });
  try {
    await page.waitForSelector('[role=tablist]', { timeout: 90000 });
    await sleep(1000);
    const spinning = await page.locator('.ant-spin-spinning, .ant-spin-blur, .ant-skeleton').count();
    assert.ok(spinning > 0, 'a loading indicator is shown while the list is slow');
    assert.equal(await rowCount(page), 0);
    await page.waitForSelector('tr.ant-table-row', { timeout: 30000 });
    assert.ok((await rowCount(page)) > 0, 'the rows appear once the response arrives');
  } finally {
    await context.close();
  }
});

qaUiTest(
  'deleted appointment: saving an edit of a record that was deleted meanwhile does not pretend to succeed or crash',
  async (ctx) => {
    const { root, world, reference } = ctx;
    const { id: created } = await world.createAppointment({
      customerId: reference.customers[0].id,
      appointmentDate: qaDate(26),
      startTime: qaTime(26, 10),
    });
    const { context, page, pageErrors } = await openAppointments(ctx.browser, {
      viewport: { width: 1280, height: 900 },
    });
    try {
      await waitForRows(page);
      const drawer = await openDrawer(page, rowsOnDate(page, 26), 'Edit');
      await root.request(`appointments:destroy?filterByTk=${created}`, { method: 'POST' });
      await pickOption(page, drawer.locator('.ant-select').nth(3), 'Confirmed');
      await submit(page, drawer);
      const exists = body(await root.request(`appointments:get?filterByTk=${created}`)).data;
      assert.ok(!exists, 'saving must not bring a deleted appointment back');
      assert.deepEqual(pageErrors, [], 'the page raised script errors');
      await page.getByRole('button', { name: 'Refresh' }).first().click();
      await sleep(3000);
      assert.equal(
        await rowsOnDate(page, 26).count(),
        0,
        'after a refresh the deleted appointment is gone from the list',
      );
    } finally {
      await context.close();
    }
  },
);

// -------------------------------------------------------------------------------------------------------------
// Empty states and filters
// -------------------------------------------------------------------------------------------------------------

qaUiTest(
  'empty states: a tab with no records and a search with no match explain themselves, and Clear filters recovers',
  async (ctx) => {
    const { context, page } = await openAppointments(ctx.browser, { viewport: { width: 1280, height: 900 } });
    try {
      await waitForRows(page);
      await page.getByPlaceholder(/Search customer/).fill('zzz-no-such-customer');
      await sleep(2500);
      const region = page.locator('[role=status]').first();
      assert.match(await region.innerText(), /match these filters/);
      assert.equal(await rowCount(page), 0);
      assert.equal((await page.locator('.ant-empty').count()) > 0, true, 'the table shows its own empty state too');
      await region.getByRole('button', { name: 'Clear filters' }).click();
      await sleep(2500);
      assert.ok((await rowCount(page)) > 0, 'Clear filters brings the rows back');
      assert.equal((await region.innerText()).trim(), '', 'and the message goes away');

      // an Events tab with nothing under it says how to fill it
      await page.getByPlaceholder(/Search customer/).fill('zzz-no-such-customer');
      await sleep(2000);
      await tab(page, 'Events').click();
      await sleep(2000);
      assert.match(await region.innerText(), /No events match these filters/);
    } finally {
      await context.close();
    }
  },
);

// -------------------------------------------------------------------------------------------------------------
// Customer sensitivities in the table: none, one, several, Other, and the accessible interaction
// -------------------------------------------------------------------------------------------------------------

qaUiTest(
  'sensitivities: none, one, several and Other are each shown correctly and are operable by keyboard',
  async (ctx) => {
    const { world, reference } = ctx;
    const { shapes } = reference;
    const plan = [
      ['none', shapes.none[0], 12],
      ['one', shapes.one[0], 13],
      ['multiple', shapes.multiple[0], 14],
      ['other', shapes.other[0], 15],
    ];
    for (const [, customer, day] of plan) {
      await world.createAppointment({
        customerId: customer.id,
        appointmentDate: qaDate(day),
        startTime: qaTime(day, 9),
      });
    }
    const sensitivityField = body(
      await ctx.root.request('collections/customers/fields:get?filterByTk=skinSensitivities'),
    ).data;
    const labels = Object.fromEntries(
      (sensitivityField.options?.enum || sensitivityField.enum || []).map((option) => [option.value, option.label]),
    );
    const expected = (customer) => {
      const other = String(customer.skinSensitivitiesOther || '').trim();
      const list = (customer.skinSensitivities || [])
        .filter(Boolean)
        .map((value) => (value === 'other' && other ? `Other: ${other}` : labels[value] || value));
      if (other && !(customer.skinSensitivities || []).includes('other')) list.push(`Other: ${other}`);
      return list;
    };

    const { context, page } = await openAppointments(ctx.browser, { viewport: { width: 1280, height: 900 } });
    try {
      await waitForRows(page);
      const headers = await page.locator('th.ant-table-cell').allInnerTexts();
      const column = headers.findIndex((header) => /Sensitivities/.test(header));
      for (const [shape, customer, day] of plan) {
        const cell = rowsOnDate(page, day).first().locator('td.ant-table-cell').nth(column);
        const want = expected(customer);
        if (shape === 'none') {
          assert.equal((await cell.innerText()).trim(), 'No sensitivities recorded');
          assert.equal(await cell.getByRole('button').count(), 0, 'no alert when nothing is recorded');
          continue;
        }
        const button = cell.getByRole('button', { name: /Skin sensitivities recorded/ });
        assert.equal(
          await button.getAttribute('aria-label'),
          `Skin sensitivities recorded: ${want.join(', ')}. Press to show details.`,
          shape,
        );
        assert.match(await button.innerText(), new RegExp(`Sensitivities\\s*${want.length}$`));

        // keyboard only: focus, Enter opens, the list matches, Escape closes and keeps focus
        await button.focus();
        await page.keyboard.press('Enter');
        const panel = page.getByRole('dialog', { name: 'Skin sensitivities recorded' });
        await panel.waitFor({ timeout: 5000 });
        assert.deepEqual(
          await panel.locator('li').allInnerTexts(),
          want,
          `${shape}: the panel lists what the customer record says`,
        );
        await page.keyboard.press('Escape');
        await sleep(500);
        assert.equal(
          await page.evaluate(() => document.activeElement?.getAttribute('aria-haspopup')),
          'dialog',
          'focus returns to the button',
        );
      }
    } finally {
      await context.close();
    }
  },
);
