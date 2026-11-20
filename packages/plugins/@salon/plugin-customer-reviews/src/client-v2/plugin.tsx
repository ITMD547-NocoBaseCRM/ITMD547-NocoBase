import { Plugin } from '@nocobase/client-v2';
import { REVIEW_ROUTE_PATH } from '../constants';

/**
 * Modern client. Registers the same public review route; in this app's `legacy-default` entry mode it is
 * reachable under `/v/review`, and at `/review` if the entry mode is switched to `modern-default`.
 */
export class PluginCustomerReviewsClientV2 extends Plugin {
  async load() {
    this.router.add('customer-review', {
      path: REVIEW_ROUTE_PATH,
      skipAuthCheck: true,
      componentLoader: () => import('./pages/ReviewRouteV2'),
    } as any);
  }
}

export default PluginCustomerReviewsClientV2;
