// Installs the employee-onboarding UI (docs/employee-onboarding.md). Environment-neutral like scripts/rbac/rbac-core.js:
// `request(action, { method, body })` → { ok, status, json }. Idempotent.
//  1. Staff page → Staff tab: "Employee accounts" JS block (scripts/ui/employee-accounts-panel.js) as the first row.
//  2. Beauty Within Portal → "My Workspace" page with the workspace JS block (scripts/ui/staff-workspace-block.js),
//     placed right after Dashboard. Who sees it is decided by scripts/rbac/rbac-spec.js (Staff).

const PANEL_MARKER = '// BW-EMPLOYEE-ACCOUNTS';
const WORKSPACE_MARKER = '// BW-STAFF-WORKSPACE';
const WORKSPACE_TITLE = 'My Workspace';

async function applyOnboardingUi(request, { panelCode, workspaceCode, check = false, log = () => {} }) {
  const call = async (action, opts) => {
    const r = await request(action, opts);
    if (!r.ok) throw new Error(`${action.split('?')[0]} failed (${r.status}): ${JSON.stringify(r.json && (r.json.errors || r.json)).slice(0, 300)}`);
    return r.json && r.json.data;
  };
  const changes = [];
  const note = (m) => { changes.push(m); log(m); };
  const routes = await call('desktopRoutes:list?paginate=false');
  const kids = (id) => routes.filter((r) => (r.parentId || null) === (id || null));
  const group = kids(null).find((r) => r.title === 'Beauty Within Portal');
  if (!group) throw new Error('Beauty Within Portal menu group not found');
  const codeOf = (m) => String((m && m.stepParams && m.stepParams.jsSettings && m.stepParams.jsSettings.runJs && m.stepParams.jsSettings.runJs.code) || '');
  const setCode = async (model, code) => {
    const stepParams = { ...model.stepParams, jsSettings: { ...((model.stepParams || {}).jsSettings || {}), runJs: { ...(((model.stepParams || {}).jsSettings || {}).runJs || {}), version: 'v2', code } } };
    await call(`flowModels:update?filterByTk=${model.uid}`, { method: 'POST', body: { stepParams } });
  };
  const gridOfTab = async (tabRoute) => call(`flowModels:findOne?parentId=${tabRoute.schemaUid}&subKey=grid`);
  const itemsOf = async (grid) => {
    const tree = (await call(`flowSurfaces:get?uid=${grid.uid}`)).tree;
    return (tree && tree.subModels && tree.subModels.items) || [];
  };
  // flowSurfaces validates block code and can't tell custom resources (employeeOnboarding:*, staffWorkspace:*) from
  // collections, so the block is created with a placeholder and its code is then set on the model.
  const addJsBlock = async (gridUid, title, marker, code) => {
    const placeholder = `${marker} (installing)\nctx.render('Loading…');`;
    const added = await call('flowSurfaces:addBlock', { method: 'POST', body: { target: { uid: gridUid }, type: 'jsBlock', settings: { ...(title ? { title } : {}), version: 'v2', code: placeholder } } });
    const model = await call(`flowModels:findOne?uid=${added.uid}`);
    await setCode(model, code);
    return added;
  };
  const moveFirst = async (gridUid, blockUid) => {
    const m = await call(`flowModels:findOne?uid=${gridUid}`);
    const props = { ...(m.props || {}) };
    if (props.rows) {
      const rowId = Object.keys(props.rows).find((k) => JSON.stringify(props.rows[k]).includes(blockUid));
      const order = (props.rowOrder || Object.keys(props.rows)).filter((k) => k !== rowId);
      if (rowId) props.rowOrder = [rowId, ...order];
    }
    // Some grids render from stepParams.gridSettings.grid instead of props: reorder that copy too.
    const stepParams = JSON.parse(JSON.stringify(m.stepParams || {}));
    const sg = stepParams.gridSettings && stepParams.gridSettings.grid;
    if (sg && sg.rows) {
      const rowId = Object.keys(sg.rows).find((k) => JSON.stringify(sg.rows[k]).includes(blockUid));
      if (rowId) sg.rowOrder = [rowId, ...(sg.rowOrder || Object.keys(sg.rows)).filter((k) => k !== rowId)];
    }
    if (props.layout && Array.isArray(props.layout.rows)) {
      const idx = props.layout.rows.findIndex((r) => JSON.stringify(r).includes(blockUid));
      if (idx > 0) { const [row] = props.layout.rows.splice(idx, 1); props.layout.rows.unshift(row); }
    }
    const body = { ...m, props, stepParams };
    delete body.subModels; delete body.parent;
    await call('flowModels:save', { method: 'POST', body });
  };

  // 1. Employee accounts panel on the Staff page.
  const staffPage = kids(group.id).find((r) => r.title === 'Staff');
  const staffTab = staffPage && kids(staffPage.id).find((r) => r.type === 'tabs' && r.title === 'Staff');
  if (!staffTab) throw new Error('Staff page / Staff tab not found');
  const staffGrid = await gridOfTab(staffTab);
  const panel = (await itemsOf(staffGrid)).find((i) => codeOf(i).startsWith(PANEL_MARKER));
  if (!panel) {
    note('Staff page: add "Employee accounts" panel');
    if (!check) {
      const added = await addJsBlock(staffGrid.uid, 'Employee accounts', PANEL_MARKER, panelCode);
      await moveFirst(staffGrid.uid, added.uid);
    }
  } else {
    if (codeOf(panel) !== panelCode) {
      note('Staff page: refresh "Employee accounts" panel code');
      if (!check) await setCode(panel, panelCode);
    }
    const g = await call(`flowModels:findOne?uid=${staffGrid.uid}`);
    const firstRow = (o) => o && o.rows && (o.rowOrder || Object.keys(o.rows))[0];
    const sg = g.stepParams && g.stepParams.gridSettings && g.stepParams.gridSettings.grid;
    const isFirst = (o) => !o || !o.rows || JSON.stringify(o.rows[firstRow(o)] || []).includes(panel.uid);
    if (!isFirst(g.props) || !isFirst(sg)) {
      note('Staff page: move "Employee accounts" panel to the top');
      if (!check) await moveFirst(staffGrid.uid, panel.uid);
    }
  }

  // 2. My Workspace page.
  let page = kids(group.id).find((r) => r.title === WORKSPACE_TITLE);
  if (!page) {
    note('menu: create "My Workspace" page');
    if (!check) {
      const created = await call('flowSurfaces:createPage', { method: 'POST', body: { title: WORKSPACE_TITLE, icon: 'IdcardOutlined', parentMenuRouteId: group.id } });
      await addJsBlock(created.gridUid, null, WORKSPACE_MARKER, workspaceCode);
      const fresh = await call('desktopRoutes:list?paginate=false');
      page = fresh.find((r) => r.parentId === group.id && r.title === WORKSPACE_TITLE);
      const dashboard = fresh.find((r) => r.parentId === group.id && r.title === 'Dashboard');
      if (page && dashboard) await call(`desktopRoutes:move?sourceId=${page.id}&targetId=${dashboard.id}&method=insertAfter&sortField=sort`, { method: 'POST' });
    }
  } else {
    const tab = kids(page.id).find((r) => r.type === 'tabs');
    const grid = tab && (await gridOfTab(tab));
    const block = grid && (await itemsOf(grid)).find((i) => codeOf(i).startsWith(WORKSPACE_MARKER));
    if (grid && !block) {
      note('My Workspace: add workspace block');
      if (!check) await addJsBlock(grid.uid, null, WORKSPACE_MARKER, workspaceCode);
    } else if (block && codeOf(block) !== workspaceCode) {
      note('My Workspace: refresh workspace code');
      if (!check) await setCode(block, workspaceCode);
    }
  }
  return changes;
}

module.exports = { applyOnboardingUi, WORKSPACE_TITLE };
