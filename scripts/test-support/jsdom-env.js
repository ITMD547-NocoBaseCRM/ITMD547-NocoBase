// Installs a jsdom window as the global DOM, the way a jest-style environment does, so React, antd and
// Testing Library can run under `node --test`. It must be called before any of them is required.

const { JSDOM, VirtualConsole } = require('jsdom');

function installDom({ url = 'http://localhost/' } = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url,
    pretendToBeVisual: true,
    virtualConsole: new VirtualConsole(),
  });
  const { window } = dom;
  // Expose jsdom's DOM classes (SVGElement, KeyboardEvent, ...) as globals.
  for (const name of Object.getOwnPropertyNames(window)) {
    if (/^[A-Z]/.test(name) && !(name in globalThis)) {
      try {
        Object.defineProperty(globalThis, name, { value: window[name], configurable: true, writable: true });
      } catch {
        // read-only host globals are left alone
      }
    }
  }
  Object.assign(globalThis, {
    window,
    document: window.document,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    getComputedStyle: window.getComputedStyle.bind(window),
    MutationObserver: window.MutationObserver,
    requestAnimationFrame: (cb) => setTimeout(cb, 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
  window.matchMedia =
    window.matchMedia ||
    (() => ({
      matches: false,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
    }));
  window.ResizeObserver =
    window.ResizeObserver ||
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  globalThis.ResizeObserver = window.ResizeObserver;
  return { dom, window };
}

module.exports = { installDom };
