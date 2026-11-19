import { Alert, Select, Space } from 'antd';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { namespace } from '../../constants';
import type { ApiClientLike } from './clerk-common';

export type Role = { name: string; title?: string };
export type NocoUser = { id: number; nickname?: string; username?: string; email?: string; roles?: Role[] };

export const errorText = (error: any) => error?.response?.data?.errors?.[0]?.message || error?.message || String(error);
export const roleTitle = (role: Role) => (role.title && !role.title.startsWith('{{') ? role.title : role.name);
export const userLabel = (user?: NocoUser) =>
  user ? user.nickname || user.username || user.email || `#${user.id}` : '';

export function useAdminT() {
  const { t } = useTranslation([namespace, 'client'], { nsMode: 'fallback' });
  return t;
}

/**
 * Picks an existing NocoBase user (with their roles shown). Warns when the user has no staff role or
 * is root, mirroring the server checks; the server remains the authority.
 */
export function UserPicker(props: {
  api: ApiClientLike;
  value?: number;
  onChange: (userId?: number) => void;
  onError: (message: string) => void;
  allowedRoles: string[];
}) {
  const { api, value, onChange, onError, allowedRoles } = props;
  const t = useAdminT();
  const [users, setUsers] = useState<NocoUser[]>([]);
  // Callers pass inline callbacks; keep the latest one without re-running the initial search.
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const search = useCallback(
    async (text = '') => {
      const filter = text
        ? {
            $or: [{ nickname: { $includes: text } }, { username: { $includes: text } }, { email: { $includes: text } }],
          }
        : undefined;
      const res = await api.request({ url: 'users:list', params: { pageSize: 50, appends: ['roles'], filter } });
      setUsers(res?.data?.data || []);
    },
    [api],
  );

  useEffect(() => {
    search().catch((e) => onErrorRef.current(errorText(e)));
  }, [search]);

  const selected = users.find((user) => user.id === value);
  const roles = (selected?.roles || []).map((role) => role.name);
  const isRoot = roles.includes('root');
  const hasStaffRole = roles.some((role) => allowedRoles.includes(role));

  return (
    <Space direction="vertical" style={{ display: 'flex' }}>
      <Select
        showSearch
        allowClear
        filterOption={false}
        onSearch={(text) => search(text).catch((e) => onErrorRef.current(errorText(e)))}
        value={value}
        onChange={onChange}
        placeholder={t('Search users')}
        style={{ width: '100%' }}
        options={users.map((user) => ({
          value: user.id,
          label: `${userLabel(user)}${user.email ? ` <${user.email}>` : ''} — ${(user.roles || [])
            .map(roleTitle)
            .join(', ')}`,
        }))}
      />
      {selected && isRoot ? (
        <Alert type="error" showIcon message={t('The root account always uses the password sign-in.')} />
      ) : null}
      {selected && !isRoot && !hasStaffRole ? (
        <Alert
          type="warning"
          showIcon
          message={t(
            'This user has no staff role yet, so Clerk sign-in will be refused until an administrator assigns one.',
          )}
        />
      ) : null}
    </Space>
  );
}
