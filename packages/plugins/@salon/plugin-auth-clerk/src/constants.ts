export const authType = 'Clerk';
export const namespace = '@salon/plugin-auth-clerk';

/** Authenticator record created (disabled) on install so an administrator only has to enable it. */
export const defaultAuthenticatorName = 'clerk';

export const linksCollection = 'clerkStaffLinks';
export const bindingsCollection = 'clerkSessionBindings';
export const invitationsCollection = 'clerkStaffInvitations';

/** Public page (both clients) where invited staff finish their Clerk registration. */
export const invitePagePath = '/staff-invite';

/** Key under the Clerk user's public metadata that carries the invitation reference. */
export const invitationMetadataKey = 'nocobaseInvitation';

/**
 * The short-lived Clerk session token travels in this header, never in the request body or URL:
 * NocoBase's request logger records action params (including body values) but only whitelisted headers.
 */
export const tokenHeader = 'x-clerk-session-token';

export const aclSnippet = 'pm.auth-clerk';

/** Error codes returned to the sign-in form so it can show a precise message. */
export const ClerkErrorCode = {
  NOT_CONFIGURED: 'CLERK_NOT_CONFIGURED',
  TOKEN_INVALID: 'CLERK_TOKEN_INVALID',
  SESSION_INACTIVE: 'CLERK_SESSION_INACTIVE',
  NOT_LINKED: 'CLERK_NOT_LINKED',
  LINK_DISABLED: 'CLERK_LINK_DISABLED',
  NO_STAFF_ROLE: 'CLERK_NO_STAFF_ROLE',
  UNAVAILABLE: 'CLERK_UNAVAILABLE',
  NOT_INVITED: 'CLERK_NOT_INVITED',
  INVITATION_REVOKED: 'CLERK_INVITATION_REVOKED',
  INVITATION_EXPIRED: 'CLERK_INVITATION_EXPIRED',
  INVITATION_USED: 'CLERK_INVITATION_USED',
  INVITATION_NOT_ACCEPTED: 'CLERK_INVITATION_NOT_ACCEPTED',
  LINK_CONFLICT: 'CLERK_LINK_CONFLICT',
} as const;
