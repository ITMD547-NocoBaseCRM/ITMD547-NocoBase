/**
 * RBAC: financial data.
 *
 * Staff (and Member) must not see revenue or any other financial information, whatever the request: lists, single
 * records, related records (`appends`, association resources such as `customers/1/payments`), aggregate `:query`
 * requests (statistics), filters and sorts that could be used to infer amounts, exports and writes.
 *
 * The role permissions (scripts/rbac/rbac-spec.js) already leave these fields and the payments table out of the
 * Staff field lists. This middleware is the second, independent layer:
 *  - a request whose resource is a financial table, or that filters, sorts, aggregates or exports a financial field
 *    (directly or through an association path) is refused with 403;
 *  - financial fields requested with `fields` / `appends`, and financial values in writes, are dropped from the request;
 *  - financial fields and records are removed from every response body, at any depth.
 *
 * Admin, Manager and root are never restricted. Receptionist keeps its existing permissions (it never had payments or
 * spend totals). Every other role is restricted when none of the caller's current roles has financial access.
 */

// BEGIN FINANCIAL-CONFIG (kept identical to FINANCIAL in scripts/rbac/rbac-spec.js; checked by scripts/rbac/rbac.test.js)
export const FINANCIAL = {
  collections: ['payments'],
  fields: {
    appointments: ['payments'],
    appointmentServices: ['priceAtBooking'],
    services: ['price'],
    customers: ['totalSpent', 'payments'],
    customerActivity: ['totalSpent', 'spentLast12m'],
    customerMemberships: ['payments'],
    memberships: ['monthlyPrice'],
  },
};
// END FINANCIAL-CONFIG

/** Roles with full financial access, and roles whose existing (partial) access is preserved as configured. */
export const FINANCIAL_ROLES = ['root', 'admin', 'manager'];
export const PRESERVED_ROLES = ['receptionist'];

export const FINANCIAL_MESSAGE = 'Financial information is not available for your role.';

const FIN_COLLECTIONS = new Set<string>(FINANCIAL.collections);
const FIN_FIELDS: Record<string, Set<string>> = Object.fromEntries(
  Object.entries(FINANCIAL.fields).map(([c, f]) => [c, new Set<string>(f as string[])]),
);

export function currentRoles(ctx: any): string[] {
  const roles = ctx?.state?.currentRoles?.length ? ctx.state.currentRoles : [ctx?.state?.currentRole].filter(Boolean);
  return roles.map(String);
}

/** True when the caller must not see financial data. Signed-out requests are restricted too. */
export function isFinanciallyRestricted(roles: string[]) {
  return !roles.some((r) => FINANCIAL_ROLES.includes(r) || PRESERVED_ROLES.includes(r));
}

export function isFinancialField(collection: string, field: string) {
  return FIN_COLLECTIONS.has(collection) || !!FIN_FIELDS[collection]?.has(field);
}

/**
 * Follows a field path from a collection. Returns a description of the first financial step, or null.
 * Unknown names and paths that continue past a scalar field are not financial (NocoBase ignores or rejects them).
 */
export function financialStep(db: any, collectionName: string, path: string[]): string | null {
  let name = collectionName;
  if (FIN_COLLECTIONS.has(name)) return name;
  for (const raw of path) {
    const seg = String(raw);
    if (!seg || seg.startsWith('$')) continue;
    if (FIN_FIELDS[name]?.has(seg)) return `${name}.${seg}`;
    const coll = db.getCollection(name);
    const field = coll?.getField?.(seg);
    if (!field) return null;
    if (!field.target) return null;
    name = field.target;
    if (FIN_COLLECTIONS.has(name)) return name;
  }
  return null;
}

const splitPath = (p: unknown): string[] => (Array.isArray(p) ? p.map(String) : String(p ?? '').replace(/^-/, '').split('.')).filter(Boolean);

/** Every field path named by a filter (nested objects, dotted keys, $and/$or arrays). */
export function filterPaths(filter: unknown, base: string[] = [], out: string[][] = []): string[][] {
  if (Array.isArray(filter)) {
    filter.forEach((f) => filterPaths(f, base, out));
  } else if (filter && typeof filter === 'object') {
    for (const [key, value] of Object.entries(filter as Record<string, unknown>)) {
      if (key.startsWith('$')) {
        filterPaths(value, base, out);
      } else {
        const path = [...base, ...key.split('.')];
        out.push(path);
        filterPaths(value, path, out);
      }
    }
  }
  return out;
}

const WRITE_ACTIONS = new Set(['create', 'update', 'updateOrCreate', 'firstOrCreate', 'set', 'add']);

/** Removes financial keys from create/update values, including nested association values. */
export function dropFinancialValues(db: any, collectionName: string, values: any, depth = 0) {
  if (!values || typeof values !== 'object' || depth > 6) return;
  if (Array.isArray(values)) { values.forEach((v) => dropFinancialValues(db, collectionName, v, depth)); return; }
  const coll = db.getCollection(collectionName);
  for (const key of Object.keys(values)) {
    if (key === 'filter' || key === 'measures' || key === 'dimensions' || key === 'orders' || key === 'columns' || key === 'sort') continue;
    if (isFinancialField(collectionName, key)) { delete values[key]; continue; }
    const target = coll?.getField?.(key)?.target;
    if (target && FIN_COLLECTIONS.has(target)) { delete values[key]; continue; }
    if (target) dropFinancialValues(db, target, values[key], depth + 1);
  }
}

const asList = (v: unknown): unknown[] => (v == null ? [] : Array.isArray(v) ? v : String(v).split(','));

/**
 * Checks one request. Returns the reason it must be refused, or null. Removes financial `fields`/`appends`/`except`
 * entries and financial write values from `params` in place.
 */
export function checkRequest(db: any, resourceName: string, actionName: string, params: any): string | null {
  const [source, assoc] = String(resourceName || '').split('.');
  let collectionName = source;
  if (assoc) {
    if (isFinancialField(source, assoc)) return `${source}.${assoc}`;
    const target = db.getCollection(source)?.getField?.(assoc)?.target;
    if (target) collectionName = target;
  }
  if (FIN_COLLECTIONS.has(collectionName)) return collectionName;
  if (!db.getCollection(collectionName)) return null; // not a collection resource (custom endpoints decide themselves)
  const p = params || {};
  const v = p.values && typeof p.values === 'object' ? p.values : {};
  const check = (path: string[]) => financialStep(db, collectionName, path);

  // Inference channels and writes: refuse.
  for (const f of [p.filter, v.filter]) for (const path of filterPaths(f)) { const hit = check(path); if (hit) return hit; }
  for (const s of [...asList(p.sort), ...asList(v.sort)]) { const hit = check(splitPath(s)); if (hit) return hit; }
  for (const list of [v.measures, v.dimensions, v.orders, p.measures, p.dimensions, p.orders]) {
    for (const item of asList(list)) {
      const field = item && typeof item === 'object' ? (item as any).field : item;
      const hit = check(splitPath(field));
      if (hit) return hit;
    }
  }
  for (const list of [p.columns, v.columns]) {
    for (const col of asList(list)) {
      const field = col && typeof col === 'object' ? ((col as any).dataIndex ?? (col as any).field ?? (col as any).name) : col;
      const hit = check(splitPath(field));
      if (hit) return hit;
    }
  }
  // Writes: financial values are never taken from these roles (prices are filled in on the server).
  if (WRITE_ACTIONS.has(actionName) && p.values && typeof p.values === 'object') dropFinancialValues(db, collectionName, p.values);

  // Read selections: drop financial entries.
  for (const key of ['fields', 'appends', 'except']) {
    if (p[key] == null) continue;
    const kept = asList(p[key]).filter((x) => !check(splitPath(x)));
    p[key] = kept;
  }
  return null;
}

/** Removes financial fields and financial records from a response body (plain objects or models), at any depth. */
export function stripFinancial(db: any, collectionName: string, body: any): any {
  const clean = (record: any, name: string, depth: number): any => {
    if (record == null || typeof record !== 'object' || depth > 8) return record;
    if (Array.isArray(record)) return record.map((r) => clean(r, name, depth));
    const plain = typeof record.toJSON === 'function' ? record.toJSON() : record;
    const coll = db.getCollection(name);
    for (const key of Object.keys(plain)) {
      if (isFinancialField(name, key)) { delete plain[key]; continue; }
      const field = coll?.getField?.(key);
      if (field?.target) {
        if (FIN_COLLECTIONS.has(field.target)) { delete plain[key]; continue; }
        plain[key] = clean(plain[key], field.target, depth + 1);
      }
    }
    return plain;
  };
  if (FIN_COLLECTIONS.has(collectionName)) return Array.isArray(body) ? [] : null;
  if (Array.isArray(body)) return body.map((r) => clean(r, collectionName, 0));
  if (body && Array.isArray(body.rows)) return { ...body, rows: body.rows.map((r: any) => clean(r, collectionName, 0)) };
  if (body && typeof body === 'object' && !Buffer.isBuffer(body) && !(typeof body.pipe === 'function')) return clean(body, collectionName, 0);
  return body;
}

export function financialGuard(app: any) {
  return async (ctx: any, next: () => Promise<any>) => {
    const roles = currentRoles(ctx);
    if (!isFinanciallyRestricted(roles)) return next();
    const db = ctx.db || app.db;
    const resourceName: string = ctx.action?.resourceName || '';
    const actionName: string = ctx.action?.actionName || '';
    const hit = checkRequest(db, resourceName, actionName, ctx.action?.params);
    if (hit) ctx.throw(403, FINANCIAL_MESSAGE);
    await next();
    const [source, assoc] = resourceName.split('.');
    const target = assoc ? db.getCollection(source)?.getField?.(assoc)?.target : source;
    if (!target || !db.getCollection(target) || ctx.body == null) return;
    if (['query'].includes(actionName)) return; // aggregate rows carry aliases only; their fields were checked above
    ctx.body = stripFinancial(db, target, ctx.body);
  };
}
