// Browser helpers for the appointment UI QA suite (US-26 / T-46).
//
// playwright-core ships with @nocobase/test (the repo's e2e tooling), so no dependency is added. A Chromium that
// matches the installed Playwright is not always present, so any Chromium already in the Playwright cache, or the
// one named by PLAYWRIGHT_CHROMIUM_PATH, is used.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadEnv } = require('../../nocobase-api');
const { pageBase } = require('./env');

const PAGE_PATH = '/admin/7rbhpfmdhv5'; // Appointments page (see scripts/appointments-page-blueprint.js)

function playwright() {
  try {
    return require('playwright-core');
  } catch {
    return null;
  }
}

function findChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH && fs.existsSync(process.env.PLAYWRIGHT_CHROMIUM_PATH)) {
    return process.env.PLAYWRIGHT_CHROMIUM_PATH;
  }
  const caches = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'ms-playwright'),
    path.join(os.homedir(), '.cache', 'ms-playwright'),
    path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright'),
  ].filter(Boolean);
  for (const cache of caches) {
    if (!fs.existsSync(cache)) continue;
    const dirs = fs
      .readdirSync(cache)
      .filter((name) => /^chromium-\d+$/.test(name))
      .sort()
      .reverse();
    for (const dir of dirs) {
      for (const candidate of [
        path.join(cache, dir, 'chrome-win64', 'chrome.exe'),
        path.join(cache, dir, 'chrome-win', 'chrome.exe'),
        path.join(cache, dir, 'chrome-linux', 'chrome'),
        path.join(cache, dir, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
      ]) {
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

function browserSupport() {
  if (!playwright()) return { ready: false, reason: 'playwright-core is not installed' };
  if (!findChromium())
    return { ready: false, reason: 'no Chromium found; install one or set PLAYWRIGHT_CHROMIUM_PATH' };
  return { ready: true, reason: '' };
}

async function signInToken() {
  const env = { ...loadEnv(), ...process.env };
  const response = await fetch(pageBase() + '/api/auth:signIn', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account: env.INIT_ROOT_EMAIL, password: env.INIT_ROOT_PASSWORD }),
  });
  const token = (await response.json())?.data?.token;
  if (!token) throw new Error(`browser sign-in failed (${response.status})`);
  return token;
}

async function launch() {
  return playwright().chromium.launch({ headless: true, executablePath: findChromium() });
}

// Opens the Appointments page as the signed-in root user (or as `token`) and records page errors and API calls.
async function openAppointments(browser, { viewport, touch = false, token, route } = {}) {
  const context = await browser.newContext({
    viewport,
    ...(touch ? { hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : {}),
  });
  const authToken = token || (await signInToken());
  await context.addInitScript((value) => {
    localStorage.setItem('NOCOBASE_TOKEN', value);
    localStorage.setItem('NOCOBASE_AUTH', 'basic');
  }, authToken);
  const page = await context.newPage();
  const base = pageBase();
  const requests = [];
  const pageErrors = [];
  page.on('request', (request) => {
    const url = request.url();
    if (url.includes('/api/') && !url.includes('/api/auth:check')) {
      requests.push({ method: request.method(), url: decodeURIComponent(url.replace(base, '')) });
    }
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  if (route) await route(page);
  await page.goto(base + PAGE_PATH + (route && route.search ? route.search : ''), { waitUntil: 'domcontentloaded' });
  return { context, page, requests, pageErrors, base };
}

async function waitForRows(page, timeout = 90000) {
  await page.waitForSelector('tr.ant-table-row', { timeout });
  await page.waitForFunction(() => /in view/.test(document.body.innerText), null, { timeout });
  await page.waitForTimeout(1500);
}

module.exports = { PAGE_PATH, browserSupport, findChromium, launch, openAppointments, signInToken, waitForRows };
