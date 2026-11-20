// Update only birthday options/date-window logic, preserving other live toolbar changes.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createClient, formatErrors, getSurface } = require('./nocobase-api');

const source = fs.readFileSync(path.join(__dirname, 'ui', 'customers-toolbar.js'), 'utf8');
function between(code, start, end) {
  const from = code.indexOf(start);
  const to = code.indexOf(end, from);
  if (from < 0 || to < 0) throw new Error(`Birthday code marker not found: ${start}`);
  return { from, to, text: code.slice(from, to) };
}
function updatedCode(current) {
  if (current.includes('Birthdays in next 2 months') && current.includes('2months')) return current;
  let code = current;
  const newline = current.includes('\r\n') ? '\r\n' : '\n';
  for (const [start, end] of [
    ['const BDAY_OPTS =', 'const SAVED_VIEW_COLLECTION ='],
    ['function bdayFilter(', '// opts.skipSelect:'],
  ]) {
    const old = between(code, start, end);
    const replacement = between(source, start, end).text.replace(/\r?\n/g, newline);
    code = code.slice(0, old.from) + replacement + code.slice(old.to);
  }
  new vm.Script(`(async function(ctx) {\n${code}\n})`);
  return code;
}

function compactForDeployment(code) {
  if (code.length <= 64 * 1024) return code;
  const compact = require('esbuild').transformSync(code, {
    loader: 'js', target: 'esnext', minifyWhitespace: true, legalComments: 'none',
  }).code;
  if (compact.length > 64 * 1024) throw new Error('Customer toolbar is still over the RunJS source limit after whitespace compaction.');
  new vm.Script(`(async function(ctx) {\n${compact}\n})`);
  return compact;
}

// Older live toolbars mount the Columns control in the native table action bar.
// Render its container through the existing React tree rather than document.createElement.
// Restore that container before React tears down its original parent on unmount.
function reactOwnedColumnsContainer(code) {
  if (!code.includes("colSlot.current = document.createElement('div')")) return code;
  let updated = code.replace('const colSlot = useRef(null);', 'const colSlot = useRef(null);\n  const colHome = useRef(null);');
  updated = updated.replace("  useEffect(() => {\n    if (!canColRoot) return undefined;", "  React.useLayoutEffect(() => {\n    if (!canColRoot) return undefined;");
  updated = updated.replace("if (!colSlot.current) { colSlot.current = document.createElement('div'); colSlot.current.className = 'bw-cols-slot'; colSlot.current.style.display = 'inline-flex'; }", 'if (!colSlot.current) return;');
  updated = updated.replace('return () => { clearInterval(timer); const r = colRoot.current;', 'return () => { clearInterval(timer); if (colHome.current && colSlot.current) colHome.current.appendChild(colSlot.current); const r = colRoot.current;');
  updated = updated.replace('if (colSlot.current) colSlot.current.remove();', '');
  const marker = "    // BW-TABLE-PREFS: keep page info and rows-per-page visible on phones";
  if (!updated.includes(marker)) throw new Error('Columns container render location not found.');
  updated = updated.replace(marker, "    h('span', { ref: colHome, style: { display: 'contents' } }, h('span', { ref: colSlot, className: 'bw-cols-slot', style: { display: 'inline-flex' } })),\n" + marker);
  if (updated.includes("colSlot.current = document.createElement('div')") || !updated.includes('React.useLayoutEffect(() => {\n    if (!canColRoot)')) throw new Error('Columns container migration failed.');
  return updated;
}

function declareMobileFilterFirst(code) {
  const from = code.indexOf('const __MobileFilters =');
  const toolbar = code.indexOf('function Toolbar()');
  if (from < 0 || toolbar < 0 || from < toolbar) return code;
  const to = code.indexOf('const CRM_MOBILE_CSS =', from);
  if (to < 0) throw new Error('Mobile filter component boundary not found.');
  return code.slice(0, toolbar) + code.slice(from, to) + '\n' + code.slice(toolbar, from) + code.slice(to);
}

async function main() {
  const check = process.argv.includes('--check');
  const client = await createClient();
  const targets = [];
  for (let page = 1; page <= 10; page++) {
    const result = await client.request(`flowModels:list?pageSize=1000&page=${page}`);
    if (!result.ok) throw new Error(formatErrors(result.json));
    const rows = result.json?.data || [];
    for (const row of rows) {
      const code = row.stepParams?.jsSettings?.runJs?.code;
      if (row.use === 'JSBlockModel' && code?.includes('BDAY_OPTS') && code.includes('customerSavedViews') && code.includes('function bdayFilter')) {
        const updated = updatedCode(code).replace(/\r\n/g, '\n');
        targets.push({ uid: row.uid, previous: code, code: compactForDeployment(declareMobileFilterFirst(reactOwnedColumnsContainer(updated))) });
      }
    }
    if (rows.length < 1000) break;
  }
  if (!targets.length) throw new Error('No customer birthday toolbar found.');
  const results = [];
  for (const target of targets) {
    const changed = target.code !== target.previous;
    if (changed && !check) {
      const result = await client.request('flowSurfaces:configure', {
        method: 'POST', body: { target: { uid: target.uid }, changes: { version: 'v2', code: target.code } },
      });
      if (!result.ok) throw new Error(`Configure ${target.uid}: ${formatErrors(result.json)}`);
      const saved = await getSurface(client, { uid: target.uid });
      if (saved.stepParams?.jsSettings?.runJs?.code !== target.code) throw new Error(`Birthday code readback failed on ${target.uid}`);
    }
    results.push({ uid: target.uid, changed });
  }
  console.log(JSON.stringify({ status: 'ok', mode: check ? 'check' : 'apply', target: client.baseUrl, toolbars: results }, null, 2));
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { updatedCode, compactForDeployment, reactOwnedColumnsContainer, declareMobileFilterFirst };
