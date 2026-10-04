import { Plugin } from '@nocobase/client';

export class PluginCrmClient extends Plugin {
  async load() {
    // Database access is server-only. Keeping the legacy client empty prevents
    // Node-only Azure SQL modules from being bundled for the browser.
  }
}

export default PluginCrmClient;
