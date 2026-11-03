import {
  Alert,
  Button,
  Card,
  Empty,
  Form,
  Input,
  List,
  message,
  Modal,
  Popconfirm,
  Radio,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { linksCollection, namespace } from '../../constants';
import { errorText, roleTitle, UserPicker, userLabel } from './admin-common';
import type { NocoUser } from './admin-common';
import type { ApiClientLike } from './clerk-common';
import { StaffInvitationsPanel } from './StaffInvitationsPanel';

type Link = {
  id: number;
  clerkUserId: string;
  clerkEmail?: string;
  enabled: boolean;
  note?: string;
  lastSignInAt?: string;
  user?: NocoUser;
};
type ClerkUser = { id: string; primaryEmail: string | null; name: string; banned: boolean; locked: boolean };
type ConfigStatus =
  | {
      configured: true;
      issuer: string;
      authorizedParties: string[];
      allowedRoles: string[];
      networklessVerification: boolean;
      sessionRecheckSeconds: number;
      inviteRedirectUrl: string;
      invitationTtlDays: number;
    }
  | { configured: false; problems: string[] };

function LinkModal(props: {
  api: ApiClientLike;
  open: boolean;
  allowedRoles: string[];
  onClose: () => void;
  onLinked: () => void;
}) {
  const { api, open, allowedRoles, onClose, onLinked } = props;
  const { t } = useTranslation([namespace, 'client'], { nsMode: 'fallback' });
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [clerkUsers, setClerkUsers] = useState<ClerkUser[] | null>(null);
  const [clerkUserId, setClerkUserId] = useState<string>();
  const [userId, setUserId] = useState<number>();
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) {
      setQuery('');
      setClerkUsers(null);
      setClerkUserId(undefined);
      setUserId(undefined);
      setNote('');
      setError('');
    }
  }, [open]);

  const lookup = async () => {
    setError('');
    setSearching(true);
    try {
      const res = await api.request({
        url: `${linksCollection}:lookupClerkUsers`,
        params: { query: query.trim() },
        skipNotify: true,
      });
      const found: ClerkUser[] = res?.data?.data || [];
      setClerkUsers(found);
      setClerkUserId(found.length === 1 ? found[0].id : undefined);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSearching(false);
    }
  };

  const submit = async () => {
    setError('');
    setSaving(true);
    try {
      await api.request({
        method: 'post',
        url: `${linksCollection}:create`,
        data: { clerkUserId, userId, note },
        skipNotify: true,
      });
      message.success(t('Staff account linked'));
      onLinked();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      title={t('Link a Clerk account to a staff user')}
      onCancel={onClose}
      okText={t('Link account')}
      okButtonProps={{ disabled: !clerkUserId || !userId, loading: saving }}
      onOk={submit}
      destroyOnClose
      width={640}
    >
      <Space direction="vertical" style={{ display: 'flex' }}>
        {error ? <Alert type="error" showIcon message={error} /> : null}
        <Typography.Text strong>{t('1. Find the Clerk account')}</Typography.Text>
        <Input.Search
          placeholder={t('Exact email address or Clerk user ID (user_...)')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onSearch={lookup}
          enterButton={t('Search Clerk')}
          loading={searching}
        />
        {clerkUsers && !clerkUsers.length ? <Empty description={t('No Clerk account found')} /> : null}
        {clerkUsers?.length ? (
          <Radio.Group value={clerkUserId} onChange={(e) => setClerkUserId(e.target.value)} style={{ width: '100%' }}>
            <List
              size="small"
              bordered
              dataSource={clerkUsers}
              renderItem={(item) => (
                <List.Item>
                  <Radio value={item.id} disabled={item.banned || item.locked}>
                    {item.name || item.primaryEmail}{' '}
                    <Typography.Text type="secondary">{item.primaryEmail}</Typography.Text>{' '}
                    <Typography.Text code>{item.id}</Typography.Text>
                    {item.banned ? <Tag color="red">{t('Banned in Clerk')}</Tag> : null}
                    {item.locked ? <Tag color="orange">{t('Locked in Clerk')}</Tag> : null}
                  </Radio>
                </List.Item>
              )}
            />
          </Radio.Group>
        ) : null}
        <Typography.Text strong>{t('2. Choose the existing NocoBase user')}</Typography.Text>
        <Typography.Text type="secondary">
          {t('Accounts are never matched by email automatically. Confirm this is the same person.')}
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

export function StaffLinksPage({ api }: { api: ApiClientLike }) {
  const { t } = useTranslation([namespace, 'client'], { nsMode: 'fallback' });
  const [status, setStatus] = useState<ConfigStatus>();
  const [links, setLinks] = useState<Link[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [modalOpen, setModalOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [statusRes, linksRes] = await Promise.all([
        api.request({ url: `${linksCollection}:configStatus` }),
        api.request({
          url: `${linksCollection}:list`,
          params: { pageSize: 500, appends: ['user', 'user.roles'], sort: ['-createdAt'] },
        }),
      ]);
      setStatus(statusRes?.data?.data);
      setLinks(linksRes?.data?.data || []);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);

  const allowedRoles = status?.configured ? status.allowedRoles : [];

  const setEnabled = async (link: Link, enabled: boolean) => {
    try {
      await api.request({
        method: 'post',
        url: `${linksCollection}:update`,
        params: { filterByTk: link.id },
        data: { enabled },
        skipNotify: true,
      });
      message.success(enabled ? t('Staff access enabled') : t('Staff access disabled'));
      load();
    } catch (e) {
      message.error(errorText(e));
    }
  };

  const unlink = async (link: Link) => {
    try {
      await api.request({
        method: 'post',
        url: `${linksCollection}:destroy`,
        params: { filterByTk: link.id },
        skipNotify: true,
      });
      message.success(t('Link removed'));
      load();
    } catch (e) {
      message.error(errorText(e));
    }
  };

  const columns = [
    {
      title: t('Clerk account'),
      key: 'clerk',
      render: (_: any, link: Link) => (
        <Space direction="vertical" size={0}>
          <span>{link.clerkEmail || '—'}</span>
          <Typography.Text type="secondary" copyable style={{ fontSize: 12 }}>
            {link.clerkUserId}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: t('NocoBase user'),
      key: 'user',
      render: (_: any, link: Link) => userLabel(link.user),
    },
    {
      title: t('Roles'),
      key: 'roles',
      render: (_: any, link: Link) => {
        const roles = link.user?.roles || [];
        const isStaff = roles.some((role) => allowedRoles.includes(role.name));
        return (
          <Space wrap size={4}>
            {roles.map((role) => (
              <Tag key={role.name} color={allowedRoles.includes(role.name) ? 'blue' : undefined}>
                {roleTitle(role)}
              </Tag>
            ))}
            {!isStaff ? <Tag color="red">{t('No staff role')}</Tag> : null}
          </Space>
        );
      },
    },
    {
      title: t('Enabled'),
      key: 'enabled',
      render: (_: any, link: Link) => (
        <Switch checked={link.enabled} onChange={(checked) => setEnabled(link, checked)} />
      ),
    },
    {
      title: t('Last Clerk sign-in'),
      key: 'lastSignInAt',
      render: (_: any, link: Link) => (link.lastSignInAt ? new Date(link.lastSignInAt).toLocaleString() : '—'),
    },
    {
      title: t('Actions'),
      key: 'actions',
      render: (_: any, link: Link) => (
        <Popconfirm
          title={t('Remove this link? The person can no longer sign in with Clerk.')}
          onConfirm={() => unlink(link)}
        >
          <Button type="link" danger>
            {t('Unlink')}
          </Button>
        </Popconfirm>
      ),
    },
  ];

  return (
    <Card>
      <Space direction="vertical" style={{ display: 'flex' }}>
        {error ? <Alert type="error" showIcon message={error} /> : null}
        {status && status.configured === false ? (
          <Alert
            type="warning"
            showIcon
            message={t('Clerk is not configured on the server')}
            description={
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {status.problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            }
          />
        ) : null}
        {status?.configured ? (
          <Alert
            type="info"
            showIcon
            message={t('Only linked, enabled accounts with a staff role can sign in with Clerk.')}
          />
        ) : null}
        <Tabs
          items={[
            {
              key: 'link',
              label: t('Link'),
              children: (
                <Space direction="vertical" style={{ display: 'flex' }}>
                  <Space>
                    <Button type="primary" onClick={() => setModalOpen(true)} disabled={!status?.configured}>
                      {t('Link staff account')}
                    </Button>
                    <Button onClick={load}>{t('Refresh')}</Button>
                  </Space>
                  <Table rowKey="id" loading={loading} dataSource={links} columns={columns as any} pagination={false} />
                </Space>
              ),
            },
            {
              key: 'invite',
              label: t('Invite'),
              children: (
                <StaffInvitationsPanel
                  api={api}
                  configured={!!status?.configured}
                  allowedRoles={allowedRoles}
                  inviteRedirectUrl={status?.configured ? status.inviteRedirectUrl : undefined}
                  invitationTtlDays={status?.configured ? status.invitationTtlDays : undefined}
                  onChanged={load}
                />
              ),
            },
          ]}
        />
      </Space>
      <LinkModal
        api={api}
        open={modalOpen}
        allowedRoles={allowedRoles}
        onClose={() => setModalOpen(false)}
        onLinked={() => {
          setModalOpen(false);
          load();
        }}
      />
    </Card>
  );
}

export default StaffLinksPage;
