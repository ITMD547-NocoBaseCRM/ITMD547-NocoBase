import { Plugin } from '@nocobase/client';
import { INSTRUCTION_TYPE, REVIEW_ROUTE_PATH } from '../constants';
import { ReviewInvitationInstruction } from './ReviewInstruction';

/**
 * Legacy client. This app runs in `legacy-default` entry mode, so public routes such as `/review` are served
 * by this client (as with the welcome page).
 */
export class PluginCustomerReviewsClient extends Plugin {
  async load() {
    this.app.router.add('customer-review', {
      path: REVIEW_ROUTE_PATH,
      // Public: customers have no CRM account. NocoBase's 401 handling must not send them to /signin.
      skipAuthCheck: true,
      componentLoader: () => import('./ReviewRouteV1'),
    } as any);

    const workflow: any = this.app.pm.get('workflow');
    workflow?.registerInstruction?.(INSTRUCTION_TYPE, ReviewInvitationInstruction);
  }
}

export default PluginCustomerReviewsClient;
