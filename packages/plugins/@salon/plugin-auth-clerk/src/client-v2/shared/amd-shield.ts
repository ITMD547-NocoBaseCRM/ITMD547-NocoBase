/**
 * NocoBase pages load RequireJS, so `window.define.amd` is set. Clerk's browser bundles
 * (clerk.browser.js and its UI) are UMD: when they see `define.amd` they call `define([], factory)`
 * instead of running, so `window.Clerk` is never created and @clerk/react reports
 * "Failed to load Clerk JS".
 *
 * This hides `define.amd` only while <script> tags served from the Clerk Frontend API host are
 * loading, and restores it as soon as the last one finishes. Scripts from anywhere else are never
 * affected.
 */

const shielded = new Set<string>();

/** `pk_test_<base64("host$")>` -> `host` (the publishable key is public; no secret involved). */
export function frontendApiHost(publishableKey: string): string | null {
  const encoded = publishableKey.split('_')[2];
  if (!encoded) return null;
  try {
    const decoded = atob(encoded);
    return decoded.endsWith('$') ? decoded.slice(0, -1) : null;
  } catch {
    return null;
  }
}

export function shieldClerkScriptsFromAmd(publishableKey: string) {
  const host = frontendApiHost(publishableKey);
  const win = window as any;
  if (!host || shielded.has(host) || typeof MutationObserver === 'undefined') return;
  shielded.add(host);

  const pending = new Set<HTMLScriptElement>();
  let savedAmd: unknown;
  let masked = false;

  const mask = () => {
    if (!masked && win.define?.amd) {
      savedAmd = win.define.amd;
      win.define.amd = undefined;
      masked = true;
    }
  };
  const unmask = () => {
    if (masked && pending.size === 0) {
      if (win.define) win.define.amd = savedAmd;
      masked = false;
    }
  };
  const track = (node: Node) => {
    if (!(node instanceof HTMLScriptElement) || !node.src || pending.has(node)) return;
    let scriptHost: string;
    try {
      scriptHost = new URL(node.src, window.location.href).host;
    } catch {
      return;
    }
    if (scriptHost !== host) return;
    pending.add(node);
    mask();
    const done = () => {
      pending.delete(node);
      unmask();
    };
    node.addEventListener('load', done, { once: true });
    node.addEventListener('error', done, { once: true });
  };

  // MutationObserver callbacks run as microtasks right after insertion, i.e. before the script has
  // downloaded and executed.
  new MutationObserver((mutations) =>
    mutations.forEach((m) => m.addedNodes.forEach(track)),
  ).observe(document.documentElement, { childList: true, subtree: true });
}
