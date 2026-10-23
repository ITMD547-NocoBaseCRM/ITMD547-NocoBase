import { Alert, Button, Input, message, Modal, Popconfirm, Space, Table, Tag, Typography } from 'antd';
import React, { useCallback, useEffect, useState } from 'react';
import { invitationsCollection } from '../../constants';
import { errorText, UserPicker, userLabel, useAdminT } from './admin-common';
import type { NocoUser } from './admin-common';
import type { ApiClientLike } from './clerk-common';

type Invitation = {
  id: number;
  email: string;
  userId: number;
  user?: NocoUser;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  expiresAt: string;
  lastSentAt?: string;
  acceptedAt?: string;
  clerkUserId?: string;
  note?: string;
};

const STATUS_COLORS: Record<Invitation['status'], string> = {
  pending: 'blue',
  accepted: 'green',
  revoked: 'default',
  expired: 'orange',
};

const formatDate = (value?: string) => (value ? new Date(value).toLocaleString() : '—');

function InviteModal(props: {
  api: ApiClientLike;
  open: boolean;
  allowedRoles: string[];
  onClose: () => void;
  onInvited: () => void;
}) {
  const { api, open, allowedRoles, onClose, onInvited } = props;
  const t = useAdminT();
  const [email, setEmail] = useState('');
  const [userId, setUserId] = useState<number>();
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) {
      setEmail('');
      setUserId(undefined);
      setNote('');
      setError('');
    }
  }, [open]);

  const submit = async () => {
    setError('');
    setSaving(true);
    try {
      await api.request({
        method: 'post',
        url: `${invitationsCollection}:create`,
        data: { email, userId, note },
        skipNotify: true,
      });
      message.success(t('Invitation sent'));
      onInvited();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      title={t('Invite staff')}
      onCancel={onClose}
      okText={t('Send invitation')}
      okButtonProps={{ disabled: !email.trim() || !userId, loading: saving }}
      onOk={submit}
      destroyOnClose
      width={600}
    >
      <Space direction="vertical" style={{ display: 'flex' }}>
        {error ? <Alert type="error" showIcon message={error} /> : null}
        <Typography.Text strong>{t('1. Staff email address')}</Typography.Text>
        <Input
          type="email"
          autoComplete="off"
          placeholder={t('name@example.com')}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Typography.Text type="secondary">
          {t('Clerk emails an invitation link. The person registers and chooses their own password.')}
        </Typography.Text>
        <Typography.Text strong>{t('2. Existing NocoBase user this person will sign in as')}</Typography.Text>
        <Typography.Text type="secondary">
          {t('Roles and permissions stay exactly as they are for this user. Nothing is assigned automatically.')}
        </Typography.Text>
        {open ? (
          <UserPicker api={api} value={userId} onChange={setUserId} onError={setError} allowedRoles={allowedRoles} />
        ) : null}
        <Input.TextArea
          placeholder={t('Note (optional)')}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
        />
      </Space>
    </Modal>
  );
}

/** Settings section: invite staff, and resend or revoke pending invitations. */
export function StaffInvitationsPanel(props: {
  api: ApiClientLike;
  configured: boolean;
  allowedRoles: string[];
  inviteRedirectUrl?: string;
  invitationTtlDays?: number;
  onChanged: () => void;
}) {
  const { api, configured, allowedRoles, inviteRedirectUrl, invitationTtlDays, onChanged } = props;
  const t = useAdminT();
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.request({ url: `${invitationsCollection}:list`, skipNotify: true });
      setInvitations(res?.data?.data || []);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);

  const act = async (invitation: Invitation, action: 'resend' | 'revoke') => {
    setBusyId(invitation.id);
    try {
      await api.request({
        method: 'post',
        url: `${invitationsCollection}:${action}`,
        params: { filterByTk: invitation.id },
        skipNotify: true,
      });
      message.success(action === 'resend' ? t('Invitation resent') : t('Invitation revoked'));
      await load();
    } catch (e) {
      message.error(errorText(e));
    } finally {
      setBusyId(null);
    }
  };

  const columns = [
    { title: t('Email'), dataIndex: 'email', key: 'email' },
    { title: t('NocoBase user'), key: 'user', render: (_: any, row: Invitation) => userLabel(row.user) },
    {
      title: t('Status'),
      key: 'status',
      render: (_: any, row: Invitation) => <Tag color={STATUS_COLORS[row.status]}>{t(row.status)}</Tag>,
    },
    { title: t('Last sent'), key: 'lastSentAt', render: (_: any, row: Invitation) => formatDate(row.lastSentAt) },
    {
      title: t('Expires / accepted'),
      key: 'expiresAt',
      render: (_: any, row: Invitation) =>
        row.status === 'accepted' ? formatDate(row.acceptedAt) : formatDate(row.expiresAt),
    },
    {
      title: t('Actions'),
      key: 'actions',
      render: (_: any, row: Invitation) =>
        row.status === 'pending' || row.status === 'expired' ? (
          <Space size={0}>
            <Button type="link" loading={busyId === row.id} onClick={() => act(row, 'resend')}>
              {t('Resend')}
            </Button>
            <Popconfirm
              title={t('Revoke this invitation? The emailed link stops working.')}
              onConfirm={() => act(row, 'revoke')}
            >
              <Button type="link" danger disabled={busyId === row.id}>
                {t('Revoke')}
              </Button>
            </Popconfirm>
          </Space>
        ) : null,
    },
  ];

  return (
    <Space direction="vertical" style={{ display: 'flex' }}>
      <Typography.Title level={5} style={{ margin: 0 }}>
        {t('Staff invitations')}
      </Typography.Title>
      <Typography.Text type="secondary">
        {t(
          'Invite new staff to create their own Clerk sign-in. They are linked to the NocoBase user you choose only after Clerk confirms the invitation was accepted.',
        )}
        {inviteRedirectUrl
          ? ` ${t('Invitation links return to')} ${inviteRedirectUrl} · ${t('valid for')} ${invitationTtlDays} ${t(
              'days',
            )}.`
          : ''}
      </Typography.Text>
      {error ? <Alert type="error" showIcon message={error} /> : null}
      <Space>
        <Button type="primary" onClick={() => setModalOpen(true)} disabled={!configured}>
          {t('Invite staff')}
        </Button>
        <Button onClick={load}>{t('Refresh')}</Button>
      </Space>
      <Table rowKey="id" loading={loading} dataSource={invitations} columns={columns as any} pagination={false} />
      <InviteModal
        api={api}
        open={modalOpen}
        allowedRoles={allowedRoles}
        onClose={() => setModalOpen(false)}
        onInvited={() => {
          setModalOpen(false);
          load();
          onChanged();
        }}
      />
    </Space>
  );
}

export default StaffInvitationsPanel;
