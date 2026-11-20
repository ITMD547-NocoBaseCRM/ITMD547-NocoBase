// Applies scripts/rbac/rbac-spec.js to a running NocoBase. Environment-neutral: `request(action, { method, body })`
// must resolve to { ok, status, json }. Used by scripts/apply-rbac.js (Node, .env credentials) and can be run from
// an admin browser session with the same adapter shape.
//
// Idempotent. Never deletes roles, users or role assignments. Admin and root are not modified (except that the
// "Access Pending" menu item is not granted to them).

async function applyRbac(request, { spec, check = false, log = () => {} } = {}) {
  const { ROLES, SCOPES, ACCESS_PENDING, PLUGIN_FIELDS = {} } = spec;
  const q = (v) => encodeURIComponent(JSON.stringify(v));
  const call = async (action, opts) => {
    const r = await request(action, opts);
    if (!r.ok) throw new Error(`${action.split('?')[0]} failed (${r.status}): ${JSON.stringify(r.json && (r.json.errors || r.json)).slice(0, 300)}`);
    return r.json && r.json.data;
  };
  const changes = [];
  const note = (msg) => { changes.push(msg); log(msg); };

  // 1. Scopes (matched by name).
  const existingScopes = await call('dataSourcesRolesResourcesScopes:list?paginate=false');
  const scopeIds = {};
  for (const [name, def] of Object.entries(SCOPES)) {
    const found = existingScopes.find((s) => s.name === name && s.resourceName === def.resourceName);
    if (found) {
      scopeIds[name] = found.id;
      if (JSON.stringify(found.scope) !== JSON.stringify(def.scope)) {
        note(`scope "${name}": update filter`);
        if (!check) await call(`dataSourcesRolesResourcesScopes:update?filterByTk=${found.id}`, { method: 'POST', body: { scope: def.scope } });
      }
    } else {
      note(`scope "${name}": create`);
      if (!check) {
        const created = await call('dataSourcesRolesResourcesScopes:create', { method: 'POST', body: { name, key: `rbac_${Math.random().toString(36).slice(2, 10)}`, dataSourceKey: 'main', resourceName: def.resourceName, scope: def.scope } });
        scopeIds[name] = created.id;
      } else scopeIds[name] = '(new)';
    }
  }

  // 2. Access Pending page (top-level menu item, visible only to Member).
  const routes = await call('desktopRoutes:list?paginate=false');
  let pending = routes.find((r) => !r.parentId && r.title === ACCESS_PENDING.title && r.type === 'flowPage');
  if (!pending) {
    note('menu: create "Access Pending" page');
    if (!check) {
      const created = await call('flowSurfaces:createPage', { method: 'POST', body: { title: ACCESS_PENDING.title, icon: ACCESS_PENDING.icon } });
      const fresh = await call('desktopRoutes:list?paginate=false');
      pending = fresh.find((r) => !r.parentId && r.title === ACCESS_PENDING.title && r.type === 'flowPage');
      const gridUid = created && (created.gridUid || (created.tab && created.tab.gridUid));
      await addPendingBlock(call, pending, gridUid, ACCESS_PENDING);
      routes.length = 0; routes.push(...fresh);
    }
  }

  // Route tree helpers (menus are matched by title path, so ids may differ between databases).
  const children = (id) => routes.filter((r) => (r.parentId || null) === (id || null));
  const descendants = (id) => children(id).flatMap((c) => [c.id, ...descendants(c.id)]);
  const resolvePath = (path) => {
    let parent = null; const chain = [];
    for (const title of path) {
      const next = children(parent).find((r) => (r.title || '') === title) || (parent && children(parent).find((r) => r.type === 'tabs' && (r.title || '') === title));
      if (!next) return null;
      chain.push(next); parent = next.id;
    }
    return chain;
  };
  const routeIdsFor = (menus) => {
    const ids = new Set();
    for (const path of menus.include) {
      const chain = resolvePath(path);
      if (!chain) { note(`menu path not found: ${path.join(' / ')}`); continue; }
      chain.forEach((r) => ids.add(r.id));
      const last = chain[chain.length - 1];
      if (last.type !== 'tabs') descendants(last.id).forEach((id) => ids.add(id));
    }
    for (const path of menus.exclude || []) {
      const chain = resolvePath(path);
      if (!chain) continue;
      const last = chain[chain.length - 1];
      [last.id, ...descendants(last.id)].forEach((id) => ids.delete(id));
    }
    return [...ids];
  };

  // An empty field list means "all fields" in the spec but "no fields" to NocoBase: expand it.
  const meta = (await call('collections:listMeta')) || [];
  // Custom JS blocks ask for related fields by path (fields[]=customer.firstName). NocoBase intersects requested
  // fields with the role's list, so "all fields" also lists one level of related-field paths (plus EXTRA_PATHS).
  // What a role may see of a related record is still limited by the CRM plugin's association field guard.
  const allFields = (collection) => {
    const c = meta.find((m) => m.name === collection);
    const names = c ? (c.fields || []).map((f) => f.name) : PLUGIN_FIELDS[collection];
    if (!names || !names.length) throw new Error(`no field list for ${collection} (add it to PLUGIN_FIELDS)`);
    const paths = [];
    for (const f of (c && c.fields) || []) {
      const target = f.target && meta.find((m) => m.name === f.target);
      if (target) for (const tf of target.fields || []) if (!tf.target) paths.push(`${f.name}.${tf.name}`);
    }
    return [...names, ...paths, ...((spec.EXTRA_PATHS || {})[collection] || [])];
  };
  const fieldsFor = (collection, action) => (action.name === 'destroy' ? [] : (action.fields && action.fields.length ? action.fields : allFields(collection)));
  // Roles marked noFinancial: drop every field or path that names financial data (spec.FINANCIAL), following
  // association paths (appointmentServices.service.price, customer.totalSpent, payments.amount …).
  const FIN = spec.FINANCIAL || { collections: [], fields: {} };
  const targetOf = (collection, name) => {
    const c = meta.find((m) => m.name === collection);
    const f = c && (c.fields || []).find((x) => x.name === name);
    return f && f.target;
  };
  const isFinancialPath = (collection, path) => {
    let name = collection;
    if (FIN.collections.includes(name)) return true;
    for (const seg of String(path).split('.')) {
      if ((FIN.fields[name] || []).includes(seg)) return true;
      const t = targetOf(name, seg);
      if (!t) return false;
      if (FIN.collections.includes(t)) return true;
      name = t;
    }
    return false;
  };
  const roleFieldsFor = (def, collection, action) => {
    const list = fieldsFor(collection, action);
    return def.noFinancial ? list.filter((p) => !isFinancialPath(collection, p)) : list;
  };

  // 3. Roles.
  for (const [roleName, def] of Object.entries(ROLES)) {
    const role = await call(`roles:get?filterByTk=${roleName}`);
    if (!role) throw new Error(`role ${roleName} does not exist (roles are never created by this script)`);
    const roleValues = { snippets: def.snippets, allowConfigure: def.allowConfigure, allowNewMenu: def.allowNewMenu, strategy: { actions: def.strategy } };
    const sorted = (x) => (Array.isArray(x) ? [...x].sort() : x);
    const roleDiff = ['snippets', 'allowConfigure', 'allowNewMenu'].some((k) => JSON.stringify(sorted(role[k] ?? null)) !== JSON.stringify(sorted(roleValues[k] ?? null)))
      || JSON.stringify((role.strategy && role.strategy.actions) || []) !== JSON.stringify(def.strategy);
    if (roleDiff) {
      note(`${roleName}: role settings (snippets ${def.snippets.join(' ')}, strategy [${def.strategy.join(',')}])`);
      if (!check) await call(`roles:update?filterByTk=${roleName}`, { method: 'POST', body: roleValues });
    }
    const dsRole = await call(`dataSources/main/roles:get?filterByTk=${roleName}`);
    if (JSON.stringify((dsRole && dsRole.strategy && dsRole.strategy.actions) || []) !== JSON.stringify(def.strategy)) {
      note(`${roleName}: main data source strategy → [${def.strategy.join(',')}]`);
      if (!check) await call(`dataSources/main/roles:update?filterByTk=${roleName}`, { method: 'POST', body: { strategy: { actions: def.strategy } } });
    }

    const current = (await call(`roles/${roleName}/resources:list?paginate=false&appends[]=actions`)) || [];
    const wanted = { ...def.collections };
    for (const res of current) if ((!res.dataSourceKey || res.dataSourceKey === 'main') && !wanted[res.name]) wanted[res.name] = [];
    for (const [name, actions] of Object.entries(wanted)) {
      if (def.noFinancial && FIN.collections.includes(name) && actions.length) throw new Error(`${roleName} is noFinancial but lists ${name}`);
      const target = actions.map((x) => ({ name: x.name, fields: roleFieldsFor(def, name, x), scopeId: x.scope ? scopeIds[x.scope] : null }));
      const existing = current.find((r) => r.name === name && (!r.dataSourceKey || r.dataSourceKey === 'main'));
      const norm = (list) => JSON.stringify((list || []).map((x) => ({ name: x.name, fields: [...(x.fields || [])].sort(), scopeId: x.scopeId ? String(x.scopeId) : null })).sort((p, n) => p.name.localeCompare(n.name)));
      if (existing && existing.usingActionsConfig && norm(existing.actions) === norm(target)) continue;
      note(`${roleName}: ${name} → ${target.map((t) => t.name + (t.scopeId ? '[scoped]' : '') + (t.fields.length ? `{${t.fields.length}f}` : '')).join(', ') || 'no access'}`);
      if (check) continue;
      const values = { dataSourceKey: 'main', name, usingActionsConfig: true, actions: target };
      if (existing) await call(`roles/${roleName}/dataSourceResources:update?filter=${q({ dataSourceKey: 'main', name })}`, { method: 'POST', body: values });
      else await call(`roles/${roleName}/dataSourceResources:create`, { method: 'POST', body: values });
    }

    const wantRoutes = routeIdsFor(def.menus);
    const haveRoutes = ((await call(`roles/${roleName}/desktopRoutes:list?paginate=false`)) || []).map((r) => r.id);
    const same = wantRoutes.length === haveRoutes.length && wantRoutes.every((id) => haveRoutes.includes(id));
    if (!same) {
      note(`${roleName}: menu → ${wantRoutes.length} items (was ${haveRoutes.length})`);
      if (!check) {
        // Granting a menu group makes NocoBase grant every page in it, so set, then take back what isn't wanted.
        await call(`roles/${roleName}/desktopRoutes:set`, { method: 'POST', body: wantRoutes });
        const granted = ((await call(`roles/${roleName}/desktopRoutes:list?paginate=false`)) || []).map((r) => r.id);
        const extra = granted.filter((id) => !wantRoutes.includes(id));
        if (extra.length) await call(`roles/${roleName}/desktopRoutes:remove`, { method: 'POST', body: extra });
      }
    }
  }

  // 4. Access Pending is only for Member: take it away from every other role that received it automatically.
  if (pending) {
    const ids = [pending.id, ...descendants(pending.id)];
    for (const roleName of ['admin', ...Object.keys(ROLES).filter((r) => r !== 'member')]) {
      const have = ((await call(`roles/${roleName}/desktopRoutes:list?paginate=false`)) || []).map((r) => r.id);
      const extra = have.filter((id) => ids.includes(id));
      if (extra.length) {
        note(`${roleName}: hide Access Pending`);
        if (!check) await call(`roles/${roleName}/desktopRoutes:remove`, { method: 'POST', body: extra });
      }
    }
  }
  return changes;
}

async function addPendingBlock(call, route, gridUid, def) {
  let grid = gridUid;
  if (!grid) {
    // Find the tab's grid through the page model.
    const page = await call(`flowSurfaces:get?uid=${route.schemaUid}`);
    const find = (node) => {
      if (!node || typeof node !== 'object') return null;
      if (node.use === 'BlockGridModel') return node.uid;
      for (const v of Object.values(node.subModels || {})) {
        for (const child of Array.isArray(v) ? v : [v]) { const hit = find(child); if (hit) return hit; }
      }
      return null;
    };
    grid = find(page && page.tree);
  }
  if (!grid) throw new Error('Access Pending: page grid not found');
  await call('flowSurfaces:addBlock', { method: 'POST', body: { target: { uid: grid }, type: 'markdown', settings: { content: PENDING_MARKDOWN } } });
}

const PENDING_MARKDOWN = `## Access Pending

Your account has been created successfully, but you have not been assigned a BeautyWithin staff role. Please contact an administrator for access.

You can update your profile or sign out from the account menu in the top-right corner.`;

module.exports = { applyRbac, PENDING_MARKDOWN };
