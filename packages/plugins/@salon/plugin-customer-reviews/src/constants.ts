export const namespace = '@salon/plugin-customer-reviews';

/** Collections (snake_case, like the other compliance tables such as communication_suppressions). */
export const REVIEWS = 'customer_reviews';
export const INVITATIONS = 'customer_review_invitations';
export const DELIVERIES = 'customer_review_deliveries';
export const MODERATION_EVENTS = 'customer_review_moderation_events';

/** Public, token-authenticated resource used by the customer review page. Not a collection. */
export const PUBLIC_RESOURCE = 'customerReviewLinks';

/**
 * Staff actions (appointment panel, moderation, statistics). A plain resource, not a collection: NocoBase's
 * flowSurfaces RunJS validator only allows standard CRUD actions on collection resources in JS blocks.
 */
export const ADMIN_RESOURCE = 'customerReviewAdmin';

/** ACL snippet that grants review management (admin and manager get it through `pm.*`). */
export const ACL_SNIPPET = 'pm.customer-reviews';

/** Workflow node type registered by this plugin. */
export const INSTRUCTION_TYPE = 'customerReviewInvitations';

/**
 * The review token travels in this request header, never in the URL path or the JSON body:
 * NocoBase's request logger records the URL and the action params (body), but only a fixed
 * whitelist of headers, so a header keeps the token out of the logs.
 */
export const TOKEN_HEADER = 'x-review-token';

/** Public page route. The token is in the URL fragment (#t=...), which browsers never send to a server. */
export const REVIEW_ROUTE_PATH = '/review';
