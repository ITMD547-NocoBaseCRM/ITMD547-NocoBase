import { Plugin } from '@nocobase/client-v2';

export class PluginCrmClientV2 extends Plugin {
  async load() {
    this.router.add('crm-customers', {
      path: '/crm/customers',
      componentLoader: () => import('./pages/CustomersPage.tsx'),
    });
  }
}

export default PluginCrmClientV2;