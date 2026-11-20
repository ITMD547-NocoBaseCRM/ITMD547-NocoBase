// BW-REVIEWS appointment-panel v2 – Customer review invitations, shown in the Appointment details drawer (T-05).
//
// Runs in NocoBase's JS block runtime. Everything goes through the @salon/plugin-customer-reviews resource
// customerReviewAdmin, whose actions are restricted on the server to root and roles with the
// `pm.customer-reviews` permission (admin, manager). For anyone else the summary request is refused and the
// block renders nothing, so it is invisible to staff who may not manage reviews.
//
// Review links are never shown here, except once right after "Create link to share", to the staff member who
// asked for it (manual fallback, e.g. a customer without transactional email consent at the front desk).

const { React } = ctx.libs;
const { Alert, Button, Input, Modal, Popconfirm, Space, Spin, Tag, Typography, message } = ctx.libs.antd;
const { useCallback, useEffect, useState } = React;
const h = React.createElement;
const RESOURCE = 'customerReviewAdmin';

async function readAppointmentId() {
  const tries = [
    async () => (await ctx.getVar('ctx.popup.record'))?.id,
    async () => ctx.view?.inputArgs?.filterByTk,
    async () => ctx.popup?.record?.id,
    async () => (await ctx.getVar('ctx.record'))?.id,
    async () => ctx.record?.id,
  ];
  for (const t of tries) {
    try {
      const id = await t();
      if (id !== undefined && id !== null && id !== '') return String(id);
    } catch (e) {
      /* try the next source */
    }
  }
  return null;
}

const fmt = (v) => {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};
const STATE_TAG = { active: ['green', 'Active'], used: ['blue', 'Review submitted'], expired: ['default', 'Expired'], revoked: ['red', 'Revoked'] };
const DELIVERY_TAG = { sent: ['green', 'Email sent'], failed: ['red', 'Email failed'], pending: ['gold', 'Email pending'], skipped: ['default', 'Not emailed'] };
const stars = (n) => '★★★★★'.slice(0, n) + '☆☆☆☆☆'.slice(0, 5 - n);
const errText = (e) => e?.response?.data?.errors?.[0]?.message || e?.message || 'Request failed.';

function Panel({ appointmentId }) {
  const [state, setState] = useState({ loading: true, data: null, error: null, hidden: false });
  const [busy, setBusy] = useState('');
  const [link, setLink] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await ctx.api.request({ url: 'customerReviewAdmin:appointmentSummary', method: 'post', data: { appointmentId }, skipNotify: true });
      setState({ loading: false, data: res?.data?.data, error: null, hidden: false });
    } catch (e) {
      const status = e?.response?.status;
      if (status === 401 || status === 403) setState({ loading: false, data: null, error: null, hidden: true });
      else setState({ loading: false, data: null, error: errText(e), hidden: false });
    }
  }, [appointmentId]);

  useEffect(() => {
    load();
  }, [load]);

  const act = async (key, action, data, okText) => {
    if (busy) return;
    setBusy(key);
    try {
      const res = await ctx.api.request({ url: `${RESOURCE}:${action}`, method: 'post', data, skipNotify: true });
      const out = res?.data?.data || {};
      if (action === 'manualLink') setLink(out);
      else if (out.status === 'failed') message.error(`Email failed: ${out.message || 'see the error below'}`);
      else if (out.status === 'skipped') message.warning(out.message || 'Nothing was sent.');
      else message.success(okText);
    } catch (e) {
      message.error(errText(e));
    } finally {
      setBusy('');
      load();
    }
  };

  if (state.hidden) return null;
  if (state.loading) return h(Spin, { size: 'small' });
  if (state.error) return h(Alert, { type: 'error', showIcon: true, message: 'Review invitations could not be loaded', description: state.error });
  const d = state.data;
  if (!d) return null;

  const header = h(Typography.Title, { level: 5, style: { marginTop: 0 } }, 'Customer review invitations');
  if (!d.reviewable) {
    return h('div', null, header, h(Typography.Text, { type: 'secondary' }, 'Review invitations are sent automatically when this appointment is marked Completed.'));
  }

  const emailNote = d.email.allowed
    ? h(Alert, { type: 'success', showIcon: true, message: 'Automatic review emails are allowed for this customer.' })
    : h(Alert, {
        type: 'warning',
        showIcon: true,
        message: 'Review emails are not sent to this customer',
        description: `${d.email.message} You can still create a link and share it in person. Never enable consent on the customer's behalf.`,
      });

  const anyActive = d.technicians.some((t) => t.invitations.some((i) => i.state === 'active'));
  const allReviewed = d.technicians.length > 0 && d.technicians.every((t) => t.review);

  const techRows = d.technicians.map((t) => {
    const latest = t.invitations[0];
    const tags = [];
    if (latest) {
      const s = STATE_TAG[latest.state];
      if (s) tags.push(h(Tag, { key: 's', color: s[0] }, s[1]));
      const dt = latest.channel === 'manual' ? ['purple', 'Shared manually'] : DELIVERY_TAG[latest.deliveryStatus];
      if (dt) tags.push(h(Tag, { key: 'd', color: dt[0] }, dt[1]));
    }
    const facts = [];
    if (latest?.sentAt) facts.push(`Sent ${fmt(latest.sentAt)}`);
    if (latest && latest.state === 'active') facts.push(`Expires ${fmt(latest.expiresAt)}`);
    if (latest?.usedAt) facts.push(`Used ${fmt(latest.usedAt)}`);
    if (latest?.revokedAt) facts.push(`Revoked ${fmt(latest.revokedAt)}${latest.revokedReason ? ` (${latest.revokedReason})` : ''}`);
    if (latest?.sendAttempts) facts.push(`${latest.sendAttempts} send attempt${latest.sendAttempts > 1 ? 's' : ''}`);

    const buttons = [];
    if (!t.review && latest && latest.state === 'active' && latest.deliveryId && latest.channel === 'email') {
      const retry = latest.deliveryStatus === 'failed' || latest.deliveryStatus === 'pending';
      buttons.push(
        h(
          Popconfirm,
          {
            key: 'resend',
            title: retry ? 'Retry sending this email?' : 'Send the email again?',
            description: 'New links are issued; links in earlier copies stop working.',
            onConfirm: () => act(`resend-${t.staffId}`, 'resend', { deliveryId: latest.deliveryId }, 'Email sent.'),
          },
          h(Button, { size: 'small', loading: busy === `resend-${t.staffId}` }, retry ? 'Retry email' : 'Resend email'),
        ),
      );
    }
    if (!t.review && latest && latest.state === 'active') {
      buttons.push(
        h(
          Popconfirm,
          { key: 'revoke', title: 'Revoke this review link?', description: 'The customer will no longer be able to use it.', onConfirm: () => act(`revoke-${t.staffId}`, 'revoke', { invitationId: latest.id }, 'Invitation revoked.') },
          h(Button, { size: 'small', danger: true, loading: busy === `revoke-${t.staffId}` }, 'Revoke'),
        ),
      );
    }
    if (!t.review && latest && (latest.state === 'expired' || latest.state === 'revoked') && d.email.allowed) {
      buttons.push(h(Button, { key: 'regen', size: 'small', loading: busy === `regen-${t.staffId}`, onClick: () => act(`regen-${t.staffId}`, 'regenerate', { invitationId: latest.id }, 'New invitation sent.') }, 'Send new invitation'));
    }
    if (!t.review) {
      buttons.push(
        h(
          Popconfirm,
          {
            key: 'manual',
            title: 'Create a review link to share in person?',
            description: latest && latest.state === 'active' ? 'This replaces the current link; the emailed one stops working.' : 'The link is shown once and expires in 7 days.',
            onConfirm: () => act(`manual-${t.staffId}`, 'manualLink', { appointmentId: d.appointmentId, staffId: t.staffId }),
          },
          h(Button, { size: 'small', type: 'link', loading: busy === `manual-${t.staffId}` }, 'Create link to share'),
        ),
      );
    }

    return h(
      'div',
      { key: t.staffId, style: { padding: '10px 0', borderTop: '1px solid #f0f0f0' } },
      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' } }, h('strong', null, t.name), ...tags),
      t.review
        ? h(
            'div',
            { style: { marginTop: 4 } },
            h('span', { 'aria-label': `${t.review.rating} of 5 stars`, style: { color: '#b07f45', letterSpacing: 1 } }, stars(t.review.rating)),
            h(Typography.Text, { type: 'secondary', style: { marginLeft: 8 } }, `${t.review.rating}/5 · submitted ${fmt(t.review.submittedAt)}${t.review.status === 'flagged' ? ' · flagged' : ''}`),
            t.review.comment ? h(Typography.Paragraph, { style: { margin: '4px 0 0', whiteSpace: 'pre-wrap' }, ellipsis: { rows: 3, expandable: true } }, t.review.comment) : null,
          )
        : h(Typography.Text, { type: 'secondary', style: { display: 'block', marginTop: 4 } }, latest ? facts.join(' · ') || ' ' : 'No invitation yet.'),
      latest && latest.lastSendError && latest.deliveryStatus === 'failed' ? h(Typography.Text, { type: 'danger', style: { display: 'block', fontSize: 12 } }, latest.lastSendError) : null,
      buttons.length ? h(Space, { wrap: true, size: 4, style: { marginTop: 6 } }, ...buttons) : null,
    );
  });

  const last = d.deliveries[0];
  const history = d.deliveries.length
    ? h(
        'details',
        { style: { marginTop: 8 } },
        h('summary', { style: { cursor: 'pointer', fontSize: 12 } }, `Delivery history (${d.deliveries.length})`),
        h(
          'ul',
          { style: { margin: '6px 0 0', paddingLeft: 18, fontSize: 12 } },
          d.deliveries.map((x) =>
            h('li', { key: x.id }, `${fmt(x.createdAt)} · ${x.trigger} · ${x.status}${x.skipMessage ? ` – ${x.skipMessage}` : ''}${x.lastError ? ` – ${x.lastError}` : ''}`),
          ),
        ),
      )
    : null;

  const sendNow =
    !allReviewed && !anyActive && d.email.allowed
      ? h(Button, { type: 'primary', size: 'small', loading: busy === 'send', onClick: () => act('send', 'sendNow', { appointmentId: d.appointmentId }, 'Invitation email sent.') }, 'Send review invitation now')
      : null;

  return h(
    'div',
    { role: 'region', 'aria-label': 'Customer review invitations' },
    header,
    emailNote,
    h('div', { style: { marginTop: 8 } }, ...techRows),
    sendNow ? h('div', { style: { marginTop: 8 } }, sendNow) : null,
    last && last.status === 'skipped' && !d.technicians.some((t) => t.invitations.length)
      ? h(Typography.Text, { type: 'secondary', style: { display: 'block', marginTop: 6, fontSize: 12 } }, `Automatic invitation skipped: ${last.skipMessage || last.skipReason}`)
      : null,
    history,
    h(
      Modal,
      { open: !!link, title: 'Review link to share', onCancel: () => setLink(null), footer: h(Button, { onClick: () => setLink(null) }, 'Done'), destroyOnClose: true },
      link
        ? h(
            'div',
            null,
            h(Typography.Paragraph, null, `Single-use link for ${link.technicianName}, valid until ${fmt(link.expiresAt)}. It is shown only now and is not stored. Share it with the customer directly; do not paste it into notes.`),
            link.emailNote ? h(Alert, { type: 'info', showIcon: true, style: { marginBottom: 8 }, message: `Email is not allowed for this customer: ${link.emailNote} Hand the link over in person or by a channel the customer agreed to.` }) : null,
            h(Input.TextArea, { readOnly: true, value: link.url, autoSize: true, 'aria-label': 'Review link', onFocus: (e) => e.target.select() }),
            h(
              Button,
              {
                style: { marginTop: 8 },
                onClick: async () => {
                  try {
                    await navigator.clipboard.writeText(link.url);
                    message.success('Link copied.');
                  } catch (e) {
                    message.info('Select the link and copy it.');
                  }
                },
              },
              'Copy link',
            ),
          )
        : null,
    ),
  );
}

const appointmentId = await readAppointmentId();
if (!appointmentId) ctx.render(null);
else ctx.render(h(Panel, { appointmentId }));
