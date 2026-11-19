import { Plugin } from '@nocobase/client';

/**
 * Legacy client. This app runs in `legacy-default` entry mode, so `/`, `/signin` and `/admin` are
 * served by this client: this is where the welcome page actually replaces NocoBase's root redirect.
 * `router.add()` with the existing name `root` replaces the built-in entry; disabling the plugin
 * restores it.
 */
export class PluginWelcomePageClient extends Plugin {
  async load() {
    this.app.router.add('root', {
      path: '/',
      // Public: NocoBase's 401 handling must not bounce visitors of the welcome page to /signin.
      skipAuthCheck: true,
      componentLoader: () => import('./WelcomeRouteV1'),
    });
  }
}

export default PluginWelcomePageClient;
