import { Plugin } from '@nocobase/server';

/**
 * The welcome page is client-only: it adds no collections, migrations, resources or ACL rules.
 * NocoBase still needs a server entry so the plugin manager can install, enable and list it.
 */
export class PluginWelcomePageServer extends Plugin {}

export default PluginWelcomePageServer;
