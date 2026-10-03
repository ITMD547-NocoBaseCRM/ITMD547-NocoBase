// Environment helpers shared by the appointment QA suites (US-26 / T-46).
//
// The suites run against a live NocoBase instance and write real rows, so they refuse to start against anything
// but a local app unless QA_ALLOW_REMOTE=1 is set, and they skip (rather than fail) when no app is running.

const { loadEnv, resolveBaseUrl } = require('../../nocobase-api');

function apiBase() {
  return resolveBaseUrl({ ...loadEnv(), ...process.env });
}

// "http://localhost:13000" without the /api/ suffix: the address the browser opens.
function pageBase() {
  return apiBase().replace(/\/api\/?$/, '');
}

function isLocal(url) {
  const { hostname } = new URL(url);
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname);
}

async function appStatus() {
  const base = apiBase();
  if (!isLocal(base) && process.env.QA_ALLOW_REMOTE !== '1') {
    return {
      ready: false,
      reason: `${base} is not a local app; set QA_ALLOW_REMOTE=1 to run the QA suites against it`,
    };
  }
  try {
    const response = await fetch(base + 'app:getInfo', { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return { ready: false, reason: `app:getInfo answered ${response.status}` };
    return { ready: true, reason: '' };
  } catch (error) {
    return { ready: false, reason: `no NocoBase app is reachable at ${base} (${error.message})` };
  }
}

module.exports = { apiBase, appStatus, isLocal, pageBase };
