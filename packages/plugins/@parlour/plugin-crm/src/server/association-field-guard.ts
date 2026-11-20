/**
 * RBAC: field permissions for related records.
 *
 * NocoBase applies a role's field permissions to the collection being queried, but a related record pulled in with
 * `appends` (for example `appointments:list?appends[]=customer`) comes back with every field of the related
 * collection. This middleware runs after the action and trims each related record to what the current role may see
 * on that record's own collection:
 *  - the role cannot read the related collection at all → the related record is removed;
 *  - the role reads it with a field allow-list → only those fields (plus id) are kept, recursively.
 * Root, and roles whose access to a collection has no field list (Admin's "all collections" strategy), are unaffected.
 */

const READ_ACTIONS = new Set(['list', 'get']);
const ALWAYS = new Set(['id']);

type Allowed = { readable: boolean; fields: Set<string> | null };

export function associationFieldGuard(app: any) {
  return async (ctx: any, next: () => Promise<any>) => {
    await next();
    const actionName = ctx.action?.actionName;
    if (!READ_ACTIONS.has(actionName)) return;
    const roles: string[] = ctx.state?.currentRoles?.length ? ctx.state.currentRoles : [ctx.state?.currentRole].filter(Boolean);
    if (!roles.length || roles.includes('root')) return;
    const resourceName: string = ctx.action?.resourceName || '';
    const db = ctx.db || app.db;
    let collection = db.getCollection(resourceName.split('.').pop());
    if (resourceName.includes('.')) {
      // association resource, e.g. customers.appointments → the target collection
      const [source, assoc] = resourceName.split('.');
      collection = db.getCollection(db.getCollection(source)?.getField(assoc)?.target);
    }
    if (!collection || ctx.body == null) return;

    const cache = new Map<string, Allowed>();
    const allowedFor = (name: string): Allowed => {
      if (cache.has(name)) return cache.get(name)!;
      let readable = false;
      let fields: Set<string> | null = new Set();
      for (const role of roles) {
        const can = app.acl.can({ role, resource: name, action: 'view' }) || app.acl.can({ role, resource: name, action: 'list' });
        if (!can) continue;
        readable = true;
        const p = can.params || {};
        const list = [...(p.fields || []), ...(p.appends || []), ...(p.whitelist || [])];
        if (!list.length) { fields = null; break; } // no field restriction for this role
        list.forEach((f: string) => fields!.add(String(f).split('.')[0]));
      }
      const result = { readable, fields: readable ? fields : new Set<string>() };
      cache.set(name, result);
      return result;
    };

    const clean = (record: any, coll: any, depth: number) => {
      if (!record || typeof record !== 'object' || depth > 6) return record;
      const plain = typeof record.toJSON === 'function' ? record.toJSON() : record;
      for (const key of Object.keys(plain)) {
        const field = coll.getField(key);
        if (!field || !field.target) continue;
        const target = db.getCollection(field.target);
        if (!target) continue;
        const allowed = allowedFor(target.name);
        if (!allowed.readable) { delete plain[key]; continue; }
        const trim = (r: any) => {
          if (!r || typeof r !== 'object') return r;
          const obj = clean(r, target, depth + 1);
          if (allowed.fields) for (const k of Object.keys(obj)) if (!ALWAYS.has(k) && !allowed.fields.has(k)) delete obj[k];
          return obj;
        };
        plain[key] = Array.isArray(plain[key]) ? plain[key].map(trim) : trim(plain[key]);
      }
      return plain;
    };

    const body = ctx.body;
    if (Array.isArray(body)) ctx.body = body.map((r) => clean(r, collection, 0));
    else if (body && Array.isArray(body.rows)) ctx.body = { ...body, rows: body.rows.map((r: any) => clean(r, collection, 0)) };
    else if (body && typeof body === 'object' && !Buffer.isBuffer(body) && !(body.pipe && typeof body.pipe === 'function')) ctx.body = clean(body, collection, 0);
  };
}
