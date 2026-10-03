// Minimal authenticated client for the local NocoBase REST API, shared by the UI scripts.
// Credentials come from .env (NOCOBASE_API_TOKEN, or the INIT_ROOT_* login) and are never logged.

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

function loadEnv(filePath = path.resolve(process.cwd(), '.env')) {
  const values = {};
  if (!fs.existsSync(filePath)) return values;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match) values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return values;
}

function resolveBaseUrl(env) {
  const explicit = process.env.NOCOBASE_API_URL || env.NOCOBASE_API_URL || env.API_BASE_URL;
  if (explicit) return explicit.replace(/\/?$/, '/');
  const port = env.APP_PORT || 13000;
  return `http://localhost:${port}${(env.API_BASE_PATH || '/api/').replace(/\/?$/, '/')}`;
}

async function createClient(options = {}) {
  const env = { ...loadEnv(), ...process.env, ...options.env };
  const baseUrl = options.baseUrl || resolveBaseUrl(env);
  let token = options.token || env.NOCOBASE_API_TOKEN;

  // Plain http(s) request without the global fetch header timeout: whole-page blueprint writes
  // can legitimately take several minutes on the server.
  const request = (action, { method = 'GET', body, headers = {} } = {}) =>
    new Promise((resolve, reject) => {
      const url = new URL(baseUrl + action);
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const transport = url.protocol === 'https:' ? https : http;
      const req = transport.request(
        url,
        {
          method,
          headers: {
            'content-type': 'application/json',
            ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}),
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...headers,
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let json = null;
            try {
              json = text ? JSON.parse(text) : null;
            } catch {
              json = null;
            }
            const status = res.statusCode || 0;
            resolve({ status, ok: status >= 200 && status < 300, json, text });
          });
        },
      );
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });

  if (!token) {
    if (!env.INIT_ROOT_EMAIL || !env.INIT_ROOT_PASSWORD) {
      throw new Error('Set NOCOBASE_API_TOKEN or INIT_ROOT_EMAIL/INIT_ROOT_PASSWORD in .env');
    }
    const signIn = await request('auth:signIn', {
      method: 'POST',
      body: { account: env.INIT_ROOT_EMAIL, password: env.INIT_ROOT_PASSWORD },
    });
    token = signIn.json?.data?.token;
    if (!token) throw new Error(`Sign-in failed with status ${signIn.status}`);
  }

  return { baseUrl, request };
}

function formatErrors(json) {
  const errors = json?.errors || json?.data?.errors;
  if (!Array.isArray(errors)) return JSON.stringify(json).slice(0, 500);
  return errors.map((error) => `${error.ruleId || error.code || 'error'}: ${error.message}`).join('\n');
}

module.exports = { createClient, formatErrors, loadEnv, resolveBaseUrl };
