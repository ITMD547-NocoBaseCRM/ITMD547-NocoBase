import { Plugin, useAPIClient } from '@nocobase/client';
import PluginAuthClient from '@nocobase/plugin-auth/client';
import React, { lazy, Suspense } from 'react';
import { Spin } from 'antd';
import { aclSnippet, authType, invitePagePath, namespace } from '../constants';
import type { ClerkAuthenticator } from '../client-v2/shared/ClerkSignInForm';

// Lazy so the Clerk SDK only loads when the Clerk tab is rendered.
const LazyClerkSignInForm = lazy(() => import('../client-v2/shared/ClerkSignInForm'));

function ClerkSignInFormV1({ authenticator }: { authenticator: ClerkAuthenticator }) {
  const api = useAPIClient();
  return (
    <Suspense fallback={<Spin />}>
      <LazyClerkSignInForm authenticator={authenticator} apiClient={api as any} />
    </Suspense>
  );
}

/**
 * Legacy client. This app runs in `legacy-default` entry mode, so `/signin` and `/admin` are served
 * by this client: the Clerk tab and the staff-link settings page must be registered here as well as
 * in client-v2.
 */
export class PluginAuthClerkClient extends Plugin {
  async load() {
    this.app.pm.get(PluginAuthClient).registerType(authType, {
      components: { SignInForm: ClerkSignInFormV1 },
    });

    this.app.pluginSettingsManager.add('auth-clerk', {
      title: this.app.i18n.t('Clerk Auth', { ns: namespace }),
      icon: 'TeamOutlined',
      aclSnippet,
      componentLoader: () => import('./StaffLinksSettings'),
    });

    // Public page Clerk invitation emails return to (/staff-invite).
    this.app.router.add('staffInvite', {
      path: invitePagePath,
      skipAuthCheck: true,
      componentLoader: () => import('./AcceptInvitationRoute'),
    });
  }
}

export default PluginAuthClerkClient;
