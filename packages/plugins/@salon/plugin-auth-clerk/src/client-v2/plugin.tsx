import { Plugin } from '@nocobase/client-v2';
import PluginAuthClientV2 from '@nocobase/plugin-auth/client-v2';
import { aclSnippet, authType } from '../constants';

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
      title: this.t('Staff sign-in (Clerk)'),
      icon: 'TeamOutlined',
      aclSnippet,
    });
    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'auth-clerk',
      key: 'index',
      title: this.t('Linked staff accounts'),
      aclSnippet,
      componentLoader: () => import('./pages/StaffLinksSettings'),
    });
  }
}

export default PluginAuthClerkClientV2;
