import { Plugin } from '@nocobase/client-v2';
import PluginAuthClientV2 from '@nocobase/plugin-auth/client-v2';
import { aclSnippet, authType, invitePagePath } from '../constants';

/**
 * Modern client (`/v/...`): adds the Clerk tab to `/v/signin` and the staff-link settings page at
 * `/v/admin/settings/auth-clerk`. Everything is lazy-loaded so Clerk's SDK is only fetched when the
 * sign-in form or the settings page is actually shown.
 */
export class PluginAuthClerkClientV2 extends Plugin {
  async load() {
    this.app.pm.get(PluginAuthClientV2).registerType(authType, {
      signInFormLoader: () => import('./forms/ClerkSignInFormV2'),
      adminSettingsFormLoader: () => import('./forms/ClerkAdminSettings'),
    });

    this.pluginSettingsManager.addMenuItem({
      key: 'auth-clerk',
      title: this.t('Clerk Auth'),
      icon: 'TeamOutlined',
      aclSnippet,
    });
    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'auth-clerk',
      key: 'index',
      title: this.t('Clerk Auth'),
      aclSnippet,
      componentLoader: () => import('./pages/StaffLinksSettings'),
    });

    // Public page Clerk invitation emails return to (/v/staff-invite).
    this.router.add('staffInvite', {
      path: invitePagePath,
      skipAuthCheck: true,
      componentLoader: () => import('./pages/AcceptInvitationRouteV2'),
    });
  }
}

export default PluginAuthClerkClientV2;
