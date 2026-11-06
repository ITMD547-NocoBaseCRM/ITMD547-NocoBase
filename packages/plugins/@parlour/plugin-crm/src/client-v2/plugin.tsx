import { Plugin } from '@nocobase/client-v2';

export class PluginCrmClientV2 extends Plugin {
  async load() {
    this.flowEngine.registerModelLoaders({
      BeautyWithinThemeToggleActionModel: {
        extends: 'TopbarActionModel',
        loader: () => import('./models/ThemeToggleTopbarActionModel'),
      },
    });
  }
}

export default PluginCrmClientV2;
