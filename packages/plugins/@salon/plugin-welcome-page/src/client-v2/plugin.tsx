import { Plugin } from '@nocobase/client-v2';

/**
 * Modern client. NocoBase registers a route named `root` at `/` that redirects to `/admin` or
 * `/signin`. `router.add()` with the same name replaces that entry, so the welcome page takes over
 * `/` and NocoBase's redirect comes back as soon as this plugin is disabled.
 *
 * In this app's `legacy-default` entry mode this client serves `/v/`; it would serve `/` if the
 * entry mode is switched to `modern-default`.
 */
export class PluginWelcomePageClientV2 extends Plugin {
  async load() {
    this.router.add('root', {
      path: '/',
      // Public: NocoBase's 401 handling must not bounce visitors of the welcome page to /signin.
      skipAuthCheck: true,
      componentLoader: () => import('./pages/WelcomeRouteV2'),
    });
  }
}

export default PluginWelcomePageClientV2;
