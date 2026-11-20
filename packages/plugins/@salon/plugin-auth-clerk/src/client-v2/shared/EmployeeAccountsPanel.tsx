/**
 * Settings → Staff Access → Employee accounts (docs/employee-onboarding.md).
 *
 * One CRM account per employee: create/link the NocoBase user, assign Staff / Receptionist / Manager, and send the
 * Clerk invitation – all through the server resource `employeeOnboarding` (Admin only; the server re-checks every
 * rule). Status is derived on the server from the real state of the user, roles, Clerk link and invitation.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Alert, Button, Checkbox, Drawer, Form, Input, Modal, Select, Space, Table, Tag, Tooltip, Typography, message } from 'antd';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { ApiClientLike } from './clerk-common';

const h: any = React.createElement;

const STATUS = {
  active: { text: 'Linked / Active', color: 'green' },
  invitation_pending: { text: 'Invitation pending', color: 'blue' },
  invitation_expired: { text: 'Invitation expired', color: 'orange' },
  pending_activation: { text: 'Pending activation', color: 'gold' },
  not_provisioned: { text: 'No account', color: 'default' },
  failed: { text: 'Provisioning failed', color: 'red' },
  disabled: { text: 'Disabled', color: 'volcano' },
};
const ROLES = [
  { value: 'staff', label: 'Staff (technician)' },
  { value: 'receptionist', label: 'Receptionist' },
  { value: 'manager', label: 'Manager' },
];
const JOB_TITLES = [
  { value: 'stylist', label: 'Stylist' },
  { value: 'therapist', label: 'Therapist' },
  { value: 'receptionist', label: 'Receptionist' },
  { value: 'manager', label: 'Manager' },
];
const ROLE_LABEL = { admin: 'Admin', manager: 'Manager', receptionist: 'Receptionist', staff: 'Staff' };
const defaultRole = (jobTitle: any) => (jobTitle === 'receptionist' ? 'receptionist' : jobTitle === 'manager' ? 'manager' : 'staff');
const fmt = (v: any) => {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};
const errText = (e: any) => e?.response?.data?.errors?.[0]?.message || e?.message || 'Request failed.';


export function EmployeeAccountsPanel({ api }: { api: ApiClientLike }) {
  const call = (action: string, data?: any): Promise<any> => api.request({ url: `employeeOnboarding:${action}`, method: 'post', data: data || {}, skipNotify: true });
  const [state, setState] = useState<any>({ loading: true, rows: [], canManage: false, error: null });
  const [busy, setBusy] = useState<any>(null);
  const [invite, setInvite] = useState<any>(null); // { row, role, mode: 'invite'|'link', userId, sendInvite }
  const [candidates, setCandidates] = useState<any[]>([]);
  const [unlink, setUnlink] = useState<any>(null);
  const [disable, setDisable] = useState<any>(null);
  const [history, setHistory] = useState<any>(null);
  const [adding, setAdding] = useState(false);
  const [form] = Form.useForm();

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const res = await call('list');
      const body = res?.data || {};
      setState({ loading: false, rows: body.data || [], canManage: !!(body.meta && body.meta.canManageAccounts), error: null });
    } catch (e) {
      setState({ loading: false, rows: [], canManage: false, error: e?.response?.status === 403 ? 'You do not have access to employee accounts.' : errText(e) });
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const run = async (key, action, data, ok) => {
    setBusy(key);
    try {
      await call(action, data);
      message.success(ok);
      await load();
      return true;
    } catch (e) {
      message.error(errText(e));
      await load();
      return false;
    } finally {
      setBusy(null);
    }
  };

  const openInvite = async (row, mode = 'invite') => {
    setInvite({ row, role: row.crmRoles.find((r) => r !== 'admin') || defaultRole(row.jobTitle), mode, userId: null, sendInvite: true });
    if (mode === 'link') {
      try {
        const res = await call('candidates');
        setCandidates(res?.data?.data || []);
      } catch (e) {
        message.error(errText(e));
      }
    }
  };

  const submitInvite = async () => {
    const { row, role, mode, userId, sendInvite } = invite;
    if (mode === 'link' && !userId) return message.error('Choose the user account that belongs to this employee.');
    const ok = await run(`invite-${row.staffId}`, 'provision', { staffId: row.staffId, role, existingUserId: mode === 'link' ? userId : undefined, sendInvite }, mode === 'link' ? 'Account linked.' : 'Invitation sent.');
    if (ok) setInvite(null);
  };

  const addEmployee = async () => {
    let values;
    try {
      values = await form.validateFields();
    } catch (_) {
      return;
    }
    setBusy('add');
    try {
      await call('createAndInvite', values);
      message.success('Employee created and invitation sent.');
      setAdding(false);
      form.resetFields();
    } catch (e) {
      message.error(errText(e));
      if (/Employee saved/.test(errText(e))) {
        setAdding(false);
        form.resetFields();
      }
    } finally {
      setBusy(null);
      load();
    }
  };

  const openHistory = async (row) => {
    setHistory({ row, loading: true, events: [] });
    try {
      const res = await call('events', { staffId: row.staffId });
      setHistory({ row, loading: false, events: res?.data?.data || [] });
    } catch (e) {
      setHistory({ row, loading: false, events: [], error: errText(e) });
    }
  };

  const counts = useMemo(() => {
    const c = {};
    for (const r of state.rows) c[r.status] = (c[r.status] || 0) + 1;
    return c;
  }, [state.rows]);

  const actionsFor = (row) => {
    const b = (key, label, onClick, extra = {}) => h(Button, { key, size: 'small', loading: busy === `${key}-${row.staffId}`, onClick, ...extra }, label);
    if (!state.canManage) {
      return row.status === 'not_provisioned' || row.status === 'failed'
        ? row.requestedAt
          ? h(Typography.Text, { type: 'secondary' }, 'Requested ', fmt(row.requestedAt))
          : b('request', 'Request account', () => run(`request-${row.staffId}`, 'requestProvisioning', { staffId: row.staffId }, 'An administrator has been asked to provision this account.'))
        : null;
    }
    const list = [];
    if (row.status === 'not_provisioned') {
      list.push(b('invite', 'Invite to CRM', () => openInvite(row), { type: 'primary' }));
      list.push(b('link', 'Link existing user', () => openInvite(row, 'link')));
    }
    if (row.status === 'failed') list.push(b('retry', 'Retry', () => (row.userId ? run(`retry-${row.staffId}`, 'provision', { staffId: row.staffId, role: row.crmRoles.find((r) => r !== 'admin') || defaultRole(row.jobTitle) }, 'Invitation sent.') : openInvite(row)), { type: 'primary' }));
    if (row.status === 'invitation_pending' || row.status === 'invitation_expired') list.push(b('resend', 'Resend invitation', () => run(`resend-${row.staffId}`, 'resend', { staffId: row.staffId }, 'Invitation sent again.')));
    if (row.status === 'pending_activation') list.push(b('invite', 'Send invitation', () => openInvite(row)));
    if (row.status === 'disabled') list.push(b('reactivate', 'Reactivate', () => run(`reactivate-${row.staffId}`, 'reactivate', { staffId: row.staffId }, 'Account reactivated.'), { type: 'primary' }));
    else if (row.userId && !row.crmRoles.includes('admin')) list.push(b('disable', 'Disable', () => setDisable({ row, reason: '', offboard: false }), { danger: true }));
    if (row.userId) list.push(b('unlink', 'Unlink', () => setUnlink({ row, reason: '' })));
    list.push(b('history', 'History', () => openHistory(row), { type: 'link' }));
    return h(Space, { wrap: true, size: 4 }, ...list);
  };

  const columns = [
    {
      title: 'Employee',
      key: 'name',
      fixed: 'left',
      render: (_, r) => h('div', null, h('div', { style: { fontWeight: 500 } }, r.name || '—'), h(Typography.Text, { type: 'secondary', style: { fontSize: 12 } }, r.email || 'no email')),
    },
    { title: 'Job title', dataIndex: 'jobTitle', key: 'jobTitle', render: (v) => (v ? v[0].toUpperCase() + v.slice(1) : '—') },
    { title: 'Employment', dataIndex: 'employment', key: 'employment', render: (v) => (v === 'active' ? h(Tag, { color: 'green' }, 'Active') : v === 'onLeave' ? h(Tag, { color: 'orange' }, 'On leave') : h(Tag, null, v || '—')) },
    { title: 'CRM role', key: 'role', render: (_, r) => (r.crmRoles.length ? r.crmRoles.map((x) => h(Tag, { key: x }, ROLE_LABEL[x] || x)) : '—') },
    { title: 'Linked account', key: 'user', render: (_, r) => (r.user ? h('div', null, r.user.nickname || r.user.username, h('div', null, h(Typography.Text, { type: 'secondary', style: { fontSize: 12 } }, r.user.email || r.user.username || ''))) : '—') },
    {
      title: 'Account status',
      key: 'status',
      render: (_, r) => {
        const s = STATUS[r.status] || { text: r.status, color: 'default' };
        const tag = h(Tag, { color: s.color }, s.text);
        return r.lastError ? h(Tooltip, { title: `${r.lastError} (${fmt(r.lastErrorAt)})` }, tag) : tag;
      },
    },
    { title: 'Invitation', key: 'inv', render: (_, r) => (r.invitation ? h('div', null, r.invitation.status, r.invitation.expiresAt && r.invitation.status === 'pending' ? h('div', null, h(Typography.Text, { type: 'secondary', style: { fontSize: 12 } }, 'expires ', fmt(r.invitation.expiresAt))) : null) : '—') },
    { title: 'Last sign-in', dataIndex: 'lastSignInAt', key: 'last', render: (v) => fmt(v) || '—' },
    { title: 'Actions', key: 'actions', render: (_, r) => actionsFor(r) },
  ];

  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
    h(
      'div',
      { style: { display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 8 } },
      h(
        'div',
        null,
        h(Typography.Title, { level: 5, style: { margin: 0 } }, 'Employee accounts'),
        h(Typography.Text, { type: 'secondary' }, 'Every active employee needs their own CRM account. ', Object.entries(counts).map(([k, n]) => `${n} ${(STATUS[k] || { text: k }).text.toLowerCase()}`).join(' · ')),
      ),
      h(Space, { wrap: true }, h(Button, { onClick: load }, 'Refresh'), state.canManage ? h(Button, { type: 'primary', onClick: () => setAdding(true) }, 'Add employee & invite') : null),
    ),
    state.error ? h(Alert, { type: 'error', showIcon: true, message: state.error }) : null,
    !state.canManage && !state.error && !state.loading
      ? h(Alert, { type: 'info', showIcon: true, message: 'Only an administrator can create accounts and assign CRM roles. Use "Request account" to ask for one.' })
      : null,
    h(Table, { rowKey: 'staffId', size: 'small', loading: state.loading, columns, dataSource: state.rows, pagination: false, scroll: { x: 1100 } }),

    // Invite / link
    invite
      ? h(
          Modal,
          {
            open: true,
            title: invite.mode === 'link' ? `Link an existing user to ${invite.row.name}` : `Invite ${invite.row.name} to the CRM`,
            okText: invite.mode === 'link' ? 'Link account' : 'Send invitation',
            confirmLoading: busy === `invite-${invite.row.staffId}`,
            onOk: submitInvite,
            onCancel: () => setInvite(null),
          },
          h(
            Space,
            { direction: 'vertical', style: { width: '100%' } },
            h(Typography.Text, null, 'CRM role'),
            h(Select, { value: invite.role, options: ROLES, style: { width: '100%' }, onChange: (role) => setInvite({ ...invite, role }) }),
            invite.mode === 'link'
              ? h(
                  React.Fragment,
                  null,
                  h(Typography.Text, null, 'Existing user (choose it yourself – emails are shown only to help you confirm it is the same person)'),
                  h(Select, {
                    showSearch: true,
                    optionFilterProp: 'label',
                    placeholder: 'Choose a user',
                    style: { width: '100%' },
                    value: invite.userId,
                    onChange: (userId) => setInvite({ ...invite, userId }),
                    options: candidates.map((u) => ({ value: u.id, label: `${u.nickname || u.username || 'User ' + u.id} · ${u.email || u.username || ''} · ${(u.roles || []).join(', ')}` })),
                  }),
                  h(Checkbox, { checked: invite.sendInvite, onChange: (e) => setInvite({ ...invite, sendInvite: e.target.checked }) }, 'Also send a Clerk sign-in invitation (if the user has no Clerk sign-in yet)'),
                )
              : h(
                  Typography.Paragraph,
                  { type: 'secondary', style: { margin: 0 } },
                  `A CRM account is created for ${invite.row.email || 'the employee'} (or the employee's linked account is reused) and an invitation email is sent through Clerk. The account becomes active when the employee accepts it.`,
                ),
          ),
        )
      : null,

    // Disable / offboard
    disable
      ? h(
          Modal,
          {
            open: true,
            title: `Disable ${disable.row.name}'s account`,
            okText: disable.offboard ? 'Offboard' : 'Disable',
            okButtonProps: { danger: true },
            confirmLoading: busy === `disable-${disable.row.staffId}`,
            onCancel: () => setDisable(null),
            onOk: async () => {
              const ok = await run(`disable-${disable.row.staffId}`, 'disable', { staffId: disable.row.staffId, reason: disable.reason, offboard: disable.offboard }, disable.offboard ? 'Employee offboarded.' : 'Account disabled.');
              if (ok) setDisable(null);
            },
          },
          h(Typography.Paragraph, null, 'Their CRM role and Clerk sign-in are switched off at once. Their appointments, shifts, notes, reviews and statistics are kept, and the account can be reactivated.'),
          h(Checkbox, { checked: disable.offboard, onChange: (e) => setDisable({ ...disable, offboard: e.target.checked }) }, 'The employee has left (also set employment to Inactive)'),
          h(Input.TextArea, { style: { marginTop: 8 }, rows: 2, placeholder: 'Reason (optional, kept in the history)', value: disable.reason, onChange: (e) => setDisable({ ...disable, reason: e.target.value }) }),
        )
      : null,

    // Unlink
    unlink
      ? h(
          Modal,
          {
            open: true,
            title: `Unlink ${unlink.row.name} from ${unlink.row.user ? unlink.row.user.nickname || unlink.row.user.username : 'the account'}`,
            okText: 'Unlink',
            okButtonProps: { danger: true, disabled: unlink.reason.trim().length < 3 },
            confirmLoading: busy === `unlink-${unlink.row.staffId}`,
            onCancel: () => setUnlink(null),
            onOk: async () => {
              const ok = await run(`unlink-${unlink.row.staffId}`, 'unlink', { staffId: unlink.row.staffId, reason: unlink.reason }, 'Account unlinked.');
              if (ok) setUnlink(null);
            },
          },
          h(Typography.Paragraph, null, 'Use this only to correct a wrong link. The user account and its roles are not changed, but it no longer sees this employee\'s work.'),
          h(Input.TextArea, { rows: 2, placeholder: 'Reason (required)', value: unlink.reason, onChange: (e) => setUnlink({ ...unlink, reason: e.target.value }) }),
        )
      : null,

    // Add employee & invite
    adding
      ? h(
          Modal,
          { open: true, title: 'Add employee & invite', okText: 'Create & send invitation', confirmLoading: busy === 'add', onOk: addEmployee, onCancel: () => setAdding(false) },
          h(
            Form,
            { form, layout: 'vertical', initialValues: { active: 'active', role: 'stylist', crmRole: 'staff' } },
            h(Form.Item, { name: 'firstName', label: 'First name', rules: [{ required: true }] }, h(Input)),
            h(Form.Item, { name: 'lastName', label: 'Last name', rules: [{ required: true }] }, h(Input)),
            h(Form.Item, { name: 'email', label: 'Email (the invitation goes here)', rules: [{ required: true, type: 'email' }] }, h(Input)),
            h(Form.Item, { name: 'phone', label: 'Phone' }, h(Input)),
            h(Form.Item, { name: 'role', label: 'Job title' }, h(Select, { options: JOB_TITLES, onChange: (v) => form.setFieldsValue({ crmRole: defaultRole(v) }) })),
            h(Form.Item, { name: 'specialty', label: 'Specialty' }, h(Input.TextArea, { rows: 2 })),
            h(Form.Item, { name: 'crmRole', label: 'CRM role', rules: [{ required: true }] }, h(Select, { options: ROLES })),
          ),
          h(Typography.Text, { type: 'secondary' }, 'Services performed can be added on the employee record afterwards.'),
        )
      : null,

    // History
    history
      ? h(
          Drawer,
          { open: true, width: 520, title: `Account history – ${history.row.name}`, onClose: () => setHistory(null) },
          history.error ? h(Alert, { type: 'error', message: history.error }) : null,
          h(Table, {
            rowKey: 'id',
            size: 'small',
            loading: history.loading,
            pagination: false,
            dataSource: history.events,
            columns: [
              { title: 'When', dataIndex: 'createdAt', render: fmt },
              { title: 'What', dataIndex: 'action', render: (v) => String(v).replace(/_/g, ' ') },
              { title: 'Details', dataIndex: 'detail', render: (d) => Object.entries(d || {}).filter(([, v]) => v !== null && v !== '' && !(Array.isArray(v) && !v.length)).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join('; ') },
              { title: 'By user', dataIndex: 'actorId', render: (v) => v || 'system' },
            ],
          }),
        )
      : null,
  );
}


export default EmployeeAccountsPanel;
