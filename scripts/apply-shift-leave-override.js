// Lets the plugin handle approved leave separately from ordinary shift overlaps.
// The native workflow continues to block overlapping working shifts, but ignores
// projected `onLeave` calendar rows so a manager can explicitly override leave.
//
// Usage: node scripts/apply-shift-leave-override.js [--check]

const { createClient, formatErrors } = require('./nocobase-api');

const WORKFLOW_TITLE = 'Validate employee shift';
const fail = (label, result) => new Error(`${label} failed (${result.status}):\n${formatErrors(result.json)}`);

async function main() {
  const check = process.argv.includes('--check');
  const client = await createClient();
  const workflows = await client.request('workflows:list?paginate=false');
  if (!workflows.ok) throw fail('list workflows', workflows);
  const workflow = (workflows.json?.data || []).find((row) => row.enabled && row.title === WORKFLOW_TITLE);
  if (!workflow) throw new Error(`Enabled workflow "${WORKFLOW_TITLE}" was not found`);

  const nodesResult = await client.request(`workflows/${workflow.id}/nodes:list?paginate=false`);
  if (!nodesResult.ok) throw fail('list workflow nodes', nodesResult);
  const changes = [];
  for (const node of nodesResult.json?.data || []) {
    if (node.type !== 'query' || node.config?.collection !== 'employeeShifts') continue;
    const filters = node.config?.params?.filter?.$and;
    if (!Array.isArray(filters)) continue;
    const status = filters.find((item) => item?.status);
    if (!status || JSON.stringify(status.status) === JSON.stringify({ $notIn: ['cancelled', 'onLeave'] })) continue;
    const config = JSON.parse(JSON.stringify(node.config));
    config.params.filter.$and.find((item) => item?.status).status = { $notIn: ['cancelled', 'onLeave'] };
    if (!check) {
      const updated = await client.request(`workflows/${workflow.id}/nodes:update?filterByTk=${node.id}`, {
        method: 'POST', body: { config },
      });
      if (!updated.ok) throw fail(`update workflow node ${node.id}`, updated);
    }
    changes.push({ id: node.id, title: node.title });
  }

  console.log(JSON.stringify({ status: 'ok', mode: check ? 'check' : 'apply', workflowId: workflow.id, changes }, null, 2));
}

main().catch((error) => {
  console.error(`Shift leave override workflow update failed: ${error.message}`);
  process.exitCode = 1;
});
