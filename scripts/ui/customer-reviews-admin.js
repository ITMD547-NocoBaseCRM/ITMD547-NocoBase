// BW-REVIEWS admin-page v4 – Customer Reviews page: submitted reviews, moderation and audit trail (T-05).
//
// Runs in NocoBase's JS block runtime. All data comes from the @salon/plugin-customer-reviews resource
// customerReviewAdmin (listReviews, moderate), enforced on the server: only root and roles with the
// `pm.customer-reviews` permission (admin, manager) can list reviews or moderate. Names are resolved server-side.
// Moderation changes only the review status (submitted <-> flagged) and always records who, when and why;
// the customer's rating and comment can never be edited or deleted.

const { React } = ctx.libs;
const { Alert, Button, DatePicker, Input, Modal, Select, Space, Table, Tag, Typography, message } = ctx.libs.antd;
const { useCallback, useEffect, useState } = React;
const h = React.createElement;

const fmt = (v) => {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};
const name = (p) => (p ? [p.firstName, p.lastName].filter(Boolean).join(' ').trim() : '') || '—';
const stars = (n) => '★★★★★'.slice(0, n) + '☆☆☆☆☆'.slice(0, 5 - n);
const errText = (e) => e?.response?.data?.errors?.[0]?.message || e?.message || 'Request failed.';

function ReviewsPage() {
  const [filters, setFilters] = useState({ staffId: 'all', rating: 'all', status: 'all', range: null, q: '' });
  const [page, setPage] = useState({ current: 1, pageSize: 20 });
  const [state, setState] = useState({ loading: true, rows: [], total: 0, error: null, forbidden: false });
  const [staff, setStaff] = useState([]);
  const [moderating, setModerating] = useState(null);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const range = filters.range && filters.range[0] && filters.range[1] ? filters.range : null;
      const res = await ctx.api.request({
        url: 'customerReviewAdmin:listReviews',
        method: 'post',
        data: {
          page: page.current,
          pageSize: page.pageSize,
          staffId: filters.staffId,
          rating: filters.rating,
          status: filters.status,
          from: range ? range[0].startOf('day').toISOString() : null,
          to: range ? range[1].endOf('day').toISOString() : null,
          q: filters.q.trim(),
        },
        skipNotify: true,
      });
      // NocoBase returns a {rows, count} result as its standard paginated shape: rows in data, the rest in meta.
      const body = res?.data || {};
      const rows = Array.isArray(body.data) ? body.data : body.data?.rows || [];
      const meta = Array.isArray(body.data) ? body.meta || {} : body.data || {};
      if (Array.isArray(meta.staffOptions)) setStaff(meta.staffOptions);
      setState({ loading: false, rows, total: meta.count || 0, error: null, forbidden: false });
    } catch (e) {
      const status = e?.response?.status;
      setState({ loading: false, rows: [], total: 0, error: status === 403 || status === 401 ? null : errText(e), forbidden: status === 403 || status === 401 });
    }
  }, [filters, page]);

  useEffect(() => {
    load();
  }, [load]);

  const submitModeration = async () => {
    if (!moderating || saving) return;
    const action = moderating.status === 'flagged' ? 'unflag' : 'flag';
    if (action === 'flag' && !reason.trim()) {
      message.error('Please give a reason for flagging this review.');
      return;
    }
    setSaving(true);
    try {
      await ctx.api.request({ url: 'customerReviewAdmin:moderate', method: 'post', data: { reviewId: moderating.id, action, reason: reason.trim() }, skipNotify: true });
      message.success(action === 'flag' ? 'Review flagged.' : 'Flag removed.');
      setModerating(null);
      setReason('');
      load();
    } catch (e) {
      message.error(errText(e));
    } finally {
      setSaving(false);
    }
  };

  if (state.forbidden) return h(Alert, { type: 'info', showIcon: true, message: 'Customer reviews are available to administrators and managers.' });

  const columns = [
    { title: 'Submitted', dataIndex: 'submittedAt', width: 170, render: (v) => fmt(v) },
    { title: 'Technician', dataIndex: 'staff', render: (v) => name(v) },
    { title: 'Customer', dataIndex: 'customer', render: (v) => name(v) },
    { title: 'Appointment', dataIndex: 'appointment', render: (a) => (a ? a.appointmentDate || fmt(a.startTime) : 'Deleted') },
    { title: 'Rating', dataIndex: 'rating', width: 120, render: (v) => h('span', { 'aria-label': `${v} of 5 stars` }, h('span', { 'aria-hidden': 'true', style: { color: '#b07f45' } }, stars(v)), ` ${v}/5`) },
    { title: 'Comment', dataIndex: 'comment', render: (v) => (v ? h(Typography.Paragraph, { style: { margin: 0, whiteSpace: 'pre-wrap' }, ellipsis: { rows: 3, expandable: true } }, v) : h(Typography.Text, { type: 'secondary' }, 'No comment')) },
    { title: 'Status', dataIndex: 'status', width: 110, render: (v) => (v === 'flagged' ? h(Tag, { color: 'orange' }, 'Flagged') : h(Tag, null, 'Submitted')) },
    {
      title: 'Moderation',
      key: 'mod',
      width: 130,
      render: (_, r) => h(Button, { size: 'small', onClick: () => { setModerating(r); setReason(''); } }, r.status === 'flagged' ? 'Remove flag' : 'Flag'),
    },
  ];

  const audit = (r) => {
    const events = (r.moderationEvents || []).slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    if (!events.length) return h(Typography.Text, { type: 'secondary' }, 'No moderation actions.');
    return h(
      'ul',
      { style: { margin: 0, paddingLeft: 18 } },
      events.map((ev) => h('li', { key: ev.id }, `${fmt(ev.createdAt)} · ${ev.action === 'flag' ? 'Flagged' : 'Flag removed'} by ${ev.createdBy ? ev.createdBy.nickname || ev.createdBy.username || ev.createdBy.email : 'unknown'}${ev.reason ? ` – ${ev.reason}` : ''}`)),
    );
  };

  return h(
    'div',
    null,
    h(Typography.Paragraph, { type: 'secondary', style: { marginTop: 0 } }, 'Reviews submitted by customers through their private review links. Ratings and comments are shown exactly as submitted. Flagging marks a review for attention; flagged reviews still count in Client Review Scores.'),
    h(
      Space,
      { wrap: true, style: { marginBottom: 12 } },
      h(Select, { 'aria-label': 'Technician', style: { minWidth: 180 }, value: filters.staffId, onChange: (v) => { setFilters((f) => ({ ...f, staffId: v })); setPage((p) => ({ ...p, current: 1 })); }, options: [{ label: 'All technicians', value: 'all' }].concat(staff.map((s) => ({ label: s.name, value: String(s.id) }))) }),
      h(Select, { 'aria-label': 'Rating', style: { minWidth: 130 }, value: filters.rating, onChange: (v) => { setFilters((f) => ({ ...f, rating: v })); setPage((p) => ({ ...p, current: 1 })); }, options: [{ label: 'All ratings', value: 'all' }].concat([5, 4, 3, 2, 1].map((n) => ({ label: `${n} star${n > 1 ? 's' : ''}`, value: String(n) }))) }),
      h(Select, { 'aria-label': 'Status', style: { minWidth: 140 }, value: filters.status, onChange: (v) => { setFilters((f) => ({ ...f, status: v })); setPage((p) => ({ ...p, current: 1 })); }, options: [{ label: 'All statuses', value: 'all' }, { label: 'Submitted', value: 'submitted' }, { label: 'Flagged', value: 'flagged' }] }),
      h(DatePicker.RangePicker, { 'aria-label': 'Submitted between', value: filters.range, onChange: (v) => { setFilters((f) => ({ ...f, range: v })); setPage((p) => ({ ...p, current: 1 })); } }),
      h(Input.Search, { 'aria-label': 'Search comments', placeholder: 'Search comments', allowClear: true, style: { width: 200 }, onSearch: (v) => { setFilters((f) => ({ ...f, q: v || '' })); setPage((p) => ({ ...p, current: 1 })); } }),
    ),
    state.error ? h(Alert, { type: 'error', showIcon: true, style: { marginBottom: 12 }, message: state.error }) : null,
    h(Table, {
      rowKey: 'id',
      size: 'middle',
      loading: state.loading,
      dataSource: state.rows,
      columns,
      scroll: { x: 960 },
      locale: { emptyText: 'No reviews yet' },
      expandable: { expandedRowRender: audit, rowExpandable: () => true },
      pagination: { current: page.current, pageSize: page.pageSize, total: state.total, showSizeChanger: true, onChange: (current, pageSize) => setPage({ current, pageSize }) },
    }),
    h(
      Modal,
      {
        open: !!moderating,
        title: moderating && moderating.status === 'flagged' ? 'Remove the flag from this review?' : 'Flag this review',
        okText: moderating && moderating.status === 'flagged' ? 'Remove flag' : 'Flag review',
        confirmLoading: saving,
        onOk: submitModeration,
        onCancel: () => setModerating(null),
        destroyOnClose: true,
      },
      h(Typography.Paragraph, null, 'The rating and comment are not changed. This action is recorded with your name and the reason below.'),
      h(Input.TextArea, { 'aria-label': 'Reason', rows: 3, maxLength: 1000, value: reason, placeholder: moderating && moderating.status === 'flagged' ? 'Reason (optional)' : 'Reason (required), e.g. contains personal information, abusive language, wrong technician', onChange: (e) => setReason(e.target.value) }),
    ),
  );
}

ctx.render(h(ReviewsPage));
