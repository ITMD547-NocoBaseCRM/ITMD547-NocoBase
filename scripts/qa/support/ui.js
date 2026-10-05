// Page-object style helpers for the appointment UI QA suite (US-26 / T-46).

const { PAGE_PATH, launch, openAppointments, waitForRows } = require('./browser');
const { qaDate } = require('./fixtures');

const tab = (page, name) => page.getByRole('tab', { name: new RegExp('(^|\\s)' + name + '(\\s|$)') });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Reads the counts shown on the three tabs.
async function tabCounts(page) {
  const counts = {};
  for (const name of ['All', 'Sessions', 'Events']) {
    const text = (await tab(page, name).innerText()).replace(/\s+/g, ' ').trim();
    counts[name] = Number((text.match(/(\d+)$/) || [])[1]);
  }
  return counts;
}

const rowCount = (page) => page.locator('tr.ant-table-row').count();
const rowsOnDate = (page, day) => page.locator('tr.ant-table-row', { hasText: qaDate(day) });
const lastDrawer = (page) => page.locator('.ant-drawer-content').last();

// Popups open as a drawer on wide screens and as a full page (a /view/ route with a back arrow) on phones.
// `trigger` is the locator to click; the result says which it was and gives the locator to search inside.
async function openPopup(page, trigger) {
  await trigger.click();
  await page.waitForFunction(
    () => document.querySelector('.ant-drawer-content') || /\/view\//.test(location.pathname),
    null,
    {
      timeout: 30000,
    },
  );
  await sleep(2500);
  const drawers = page.locator('.ant-drawer-content');
  const mode = (await drawers.count()) ? 'drawer' : 'page';
  return { mode, scope: mode === 'drawer' ? drawers.last() : page.locator('body') };
}

async function closePopup(page, mode = 'drawer') {
  if (mode === 'drawer') {
    await page.keyboard.press('Escape');
    await sleep(700);
    return;
  }
  await page.goBack();
  await page.waitForSelector('[role=tablist]', { timeout: 30000 });
  await sleep(1500);
}

// Drawer-only conveniences used by the desktop journeys.
async function openDrawer(page, rowLocator, action) {
  const { scope } = await openPopup(page, rowLocator.first().getByText(action, { exact: true }));
  return scope;
}

async function closeDrawer(page) {
  await closePopup(page, 'drawer');
}

async function pickOption(page, select, optionText) {
  await select.click();
  const options = page.locator('.ant-select-dropdown:visible .ant-select-item-option');
  const option = optionText ? options.filter({ hasText: optionText }).first() : options.first();
  await option.waitFor({ timeout: 15000 });
  await option.click();
}

// Fills the New appointment form. The appointment date is not on the form: it is created from the start time.
// `customer` may be an option label; the first option is used when omitted.
async function fillForm(
  page,
  scope,
  { customer, category, day, time = '10:00:00', endTime, skipCustomer = false, skipStart = false } = {},
) {
  const selects = scope.locator('.ant-select');
  if (!skipCustomer) await pickOption(page, selects.nth(0), customer);
  if (category) await pickOption(page, selects.nth(1), category);
  if (skipStart) return;
  const pickers = scope.locator('.ant-picker input');
  const fillPicker = async (index, value) => {
    const input = pickers.nth(index);
    await input.click();
    await input.fill(value);
    await page.keyboard.press('Enter');
    await sleep(400);
    const ok = page.locator('.ant-picker-ok button:visible');
    if (await ok.count()) await ok.first().click();
    await sleep(300);
  };
  await fillPicker(0, `${qaDate(day)} ${time}`);
  if (endTime) await fillPicker(1, `${qaDate(day)} ${endTime}`);
}

async function submit(page, scope) {
  await scope.getByRole('button', { name: 'Submit' }).click();
  await sleep(3500);
}

// Text of the antd toast (success or error) currently on screen.
const toastText = async (page) =>
  (await page.locator('.ant-message-notice, .ant-notification-notice').allInnerTexts()).join(' | ');

module.exports = {
  PAGE_PATH,
  closeDrawer,
  closePopup,
  fillForm,
  lastDrawer,
  launch,
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
};
