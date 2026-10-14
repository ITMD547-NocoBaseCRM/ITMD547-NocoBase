// Inline status dropdown for the Appointments table (US-26).
//
// Runs inside NocoBase's JS field runtime, once per appointment row. Picking a status saves it straight to the
// appointment through the standard appointments resource, so the server-side ACL and the availability checks
// apply exactly as they do in the edit form. A rejected change (for example a time conflict) shows the server's
// message and puts the previous status back.

const { React } = ctx.libs;
const { Select, message } = ctx.libs.antd;
const { useState } = React;
const e = React.createElement;

const clean = (s) => String(s == null ? '' : s).replace(/^\{\{\s*t\(\s*["'](.*)["']\s*\)\s*\}\}$/, '$1');
const COLORS = { scheduled: '#2563eb', confirmed: '#0891b2', inProgress: '#d97706', completed: '#16a34a', cancelled: '#6b7280', noShow: '#dc2626' };

const record = (await ctx.getVar('ctx.record')) || {};
let options = [];
try {
  const coll = ctx.dataSourceManager.getDataSource('main').collectionManager.getCollection('appointments');
  const field = coll && coll.getFields().find((f) => f.name === 'status');
  const list = (field && (field.enum || (field.options && field.options.enum) || (field.uiSchema && field.uiSchema.enum))) || [];
  options = list.map((o) => ({ value: o.value, label: clean(o.label == null ? o.value : o.label) }));
} catch (err) { /* falls back to the current value only */ }
if (record.status && !options.some((o) => o.value === record.status)) options.push({ value: record.status, label: record.status });

function StatusSelect() {
  const [value, setValue] = useState(record.status);
  const [saving, setSaving] = useState(false);
  const change = async (next) => {
    const previous = value;
    setValue(next); setSaving(true);
    try {
      await ctx.api.request({ url: 'appointments:update', method: 'post', params: { filterByTk: record.id }, data: { status: next } });
      message.success('Status updated');
      // Let the toolbar's status tiles and tab counts catch up with the change.
      try { const resource = ctx.blockModel && ctx.blockModel.resource; if (resource && resource.refresh) await resource.refresh(); } catch (err) { /* the row is already updated */ }
    } catch (error) {
      setValue(previous);
      const errors = error && error.response && error.response.data && error.response.data.errors;
      message.error((errors && errors[0] && errors[0].message) || 'Could not update the status. Please try again.');
    } finally { setSaving(false); }
  };
  return e(Select, {
    size: 'small', value, loading: saving, disabled: saving, onChange: change, options,
    style: { minWidth: 130, color: COLORS[value] || undefined },
    'aria-label': 'Appointment status',
    onClick: (event) => event.stopPropagation(),
  });
}
ctx.render(e(StatusSelect));
