import { Alert } from 'antd';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { namespace } from '../../constants';

/** Shown in the authenticator drawer. Clerk keys are environment variables, never stored here. */
export default function ClerkAdminSettings() {
  const { t } = useTranslation([namespace, 'client'], { nsMode: 'fallback' });
  return (
    <Alert
      type="info"
      showIcon
      message={t('Clerk keys are configured with server environment variables (CLERK_*), not here.')}
      description={t(
        'Link staff accounts under Settings → Clerk Auth. Keep the Password authenticator enabled as the administrator fallback.',
      )}
    />
  );
}
