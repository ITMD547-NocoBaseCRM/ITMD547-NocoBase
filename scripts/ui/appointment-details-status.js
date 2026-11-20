// Editable appointment status dropdown for the Details drawer.
const { React } = ctx.libs;
const { Select, message } = ctx.libs.antd;
const { useState } = React;
const h = React.createElement;
const record = (await ctx.getVar('ctx.record')) || {};

const clean = (value) => String(value == null ? '' : value).replace(/^\{\{\s*t\(\s*["'](.*)["']\s*\)\s*\}\}$/, '$1');
const COLORS = {
  scheduled: '#2563eb', confirmed: '#0891b2', checkedIn: '#06b6d4',
  inProgress: '#d97706', completed: '#16a34a', cancelled: '#6b7280', noShow: '#dc2626',
};
let options = [];
try {
  const collection = ctx.dataSourceManager.getDataSource('main').collectionManager.getCollection('appointments');
  const field = collection?.getFields().find((item) => item.name === 'status');
  const values = field?.enum || field?.options?.enum || field?.uiSchema?.enum || [];
  options = values.map((item) => ({ value: item.value, label: clean(item.label == null ? item.value : item.label) }));
} catch (error) { /* current value is added below */ }
if (record.status && !options.some((item) => item.value === record.status)) options.push({ value: record.status, label: record.status });

function StatusDropdown() {
  const [value, setValue] = useState(record.status);
  const [saving, setSaving] = useState(false);
  const change = async (next) => {
    const previous = value;
    setValue(next); setSaving(true);
    try {
      const resource = ctx.makeResource('SingleRecordResource');
      resource.setResourceName('appointments');
      resource.setFilterByTk(record.id);
      await resource.save({ status: next }, { refresh: false });
      message.success('Appointment status updated.');
      try {
        const blockResource = ctx.blockModel?.resource;
        if (blockResource?.refresh) await blockResource.refresh();
      } catch (error) { /* local selection already shows the saved status */ }
    } catch (error) {
      setValue(previous);
      message.error('The status could not be updated. Please try again.');
    } finally { setSaving(false); }
  };
  return h(Select, {
    size: 'small', value, options, onChange: change, loading: saving, disabled: saving,
    style: { width: '100%', maxWidth: 220, color: COLORS[value] || undefined },
    popupMatchSelectWidth: 220, 'aria-label': 'Appointment status',
  });
}
ctx.render(h(StatusDropdown));
