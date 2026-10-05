// Test harness for the appointment QA suites (US-26 / T-46).
//
// `qaTest` behaves like node:test's `test`, but resolves a shared, lazily built context first (an authenticated root
// client, tracked fixtures and the reference data) and skips when no local app is running. Everything the suites
// create is removed after the last test, and a sweep before the first test clears leftovers of an interrupted run.

const { after, test } = require('node:test');
const { appStatus } = require('./env');
const { browserSupport, launch } = require('./browser');
const { World, createRootClient, loadReference, sweep, sweepAppointments } = require('./fixtures');

let contextPromise = null;

function context() {
  if (!contextPromise) {
    contextPromise = (async () => {
      const status = await appStatus();
      if (!status.ready) return { status };
      const root = await createRootClient();
      await sweep(root);
      const world = new World(root);
      const reference = await loadReference(root);
      return { status, root, world, reference };
    })();
  }
  return contextPromise;
}

function qaTest(name, fn, options = {}) {
  return test(name, options, async (t) => {
    const ctx = await context();
    if (!ctx.status.ready) {
      t.skip(ctx.status.reason);
      return;
    }
    // every test starts with an empty QA date range, so counts never depend on test order
    await sweepAppointments(ctx.root);
    ctx.world.appointments.length = 0;
    await fn(ctx, t);
  });
}

// UI tests also need a browser. It is launched once and shared; each test opens its own context.
let browserPromise = null;
const getBrowser = () => (browserPromise ||= launch());

function qaUiTest(name, fn, options = {}) {
  return qaTest(
    name,
    async (ctx, t) => {
      const support = browserSupport();
      if (!support.ready) {
        t.skip(support.reason);
        return;
      }
      await fn({ ...ctx, browser: await getBrowser() }, t);
    },
    options,
  );
}

after(async () => {
  if (browserPromise) await (await browserPromise).close();
});

after(async () => {
  if (!contextPromise) return;
  const ctx = await contextPromise;
  if (ctx.world) await ctx.world.cleanup();
});

// A request is "rejected" when the server answered with an error status.
const isRejected = (response) => response.status >= 400;

module.exports = { context, isRejected, qaTest, qaUiTest };
