import { createClerkClient } from '@clerk/backend';

export type ClerkUserSummary = {
  id: string;
  primaryEmail: string | null;
  name: string;
  banned: boolean;
  locked: boolean;
  /** Lower-cased addresses whose verification status is "verified". */
  verifiedEmails: string[];
  /** Server-writable only (Backend API); invitations copy their public metadata here at sign-up. */
  publicMetadata: Record<string, unknown>;
  /** Epoch milliseconds. */
  createdAt: number;
};

export type ClerkInvitationSummary = {
  id: string;
  emailAddress: string;
  /** 'pending' | 'accepted' | 'revoked' | 'expired' */
  status: string;
  createdAt: number;
};

export type CreateInvitationParams = {
  emailAddress: string;
  redirectUrl: string;
  publicMetadata: Record<string, unknown>;
  expiresInDays: number;
};

/** The few Clerk Backend API calls this plugin makes. Tests substitute a fake. */
export interface ClerkApi {
  getSessionStatus(sessionId: string): Promise<string>;
  revokeSession(sessionId: string): Promise<void>;
  getUser(clerkUserId: string): Promise<ClerkUserSummary | null>;
  findUsersByEmail(email: string): Promise<ClerkUserSummary[]>;
  createInvitation(params: CreateInvitationParams): Promise<ClerkInvitationSummary>;
  revokeInvitation(invitationId: string): Promise<void>;
  /** Clerk has no "get invitation by id": search by the invited address and match the id. */
  findInvitation(invitationId: string, emailAddress: string): Promise<ClerkInvitationSummary | null>;
}

const summarize = (user: any): ClerkUserSummary => {
  const primary = user.emailAddresses?.find((item: any) => item.id === user.primaryEmailAddressId);
  return {
    id: user.id,
    primaryEmail: primary?.emailAddress ?? null,
    name: [user.firstName, user.lastName].filter(Boolean).join(' '),
    banned: !!user.banned,
    locked: !!user.locked,
    verifiedEmails: (user.emailAddresses || [])
      .filter((item: any) => item.verification?.status === 'verified')
      .map((item: any) => String(item.emailAddress).toLowerCase()),
    publicMetadata: (user.publicMetadata as Record<string, unknown>) || {},
    createdAt: Number(user.createdAt) || 0,
  };
};

const summarizeInvitation = (invitation: any): ClerkInvitationSummary => ({
  id: invitation.id,
  emailAddress: invitation.emailAddress,
  status: invitation.revoked ? 'revoked' : invitation.status,
  createdAt: Number(invitation.createdAt) || 0,
});

const isNotFound = (error: any) => error?.status === 404;

export function createClerkApi(secretKey: string): ClerkApi {
  const client = createClerkClient({ secretKey });
  return {
    async getSessionStatus(sessionId) {
      try {
        return (await client.sessions.getSession(sessionId)).status;
      } catch (error) {
        if (isNotFound(error)) return 'not_found';
        throw error;
      }
    },
    async revokeSession(sessionId) {
      try {
        await client.sessions.revokeSession(sessionId);
      } catch (error) {
        // Already gone is the outcome we wanted.
        if (!isNotFound(error)) throw error;
      }
    },
    async getUser(clerkUserId) {
      try {
        return summarize(await client.users.getUser(clerkUserId));
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    async findUsersByEmail(email) {
      const { data } = await client.users.getUserList({ emailAddress: [email], limit: 10 });
      return data.map(summarize);
    },
    async createInvitation(params) {
      return summarizeInvitation(
        await client.invitations.createInvitation({
          emailAddress: params.emailAddress,
          redirectUrl: params.redirectUrl,
          publicMetadata: params.publicMetadata as any,
          expiresInDays: params.expiresInDays,
          notify: true,
        }),
      );
    },
    async revokeInvitation(invitationId) {
      await client.invitations.revokeInvitation(invitationId);
    },
    async findInvitation(invitationId, emailAddress) {
      const { data } = await client.invitations.getInvitationList({ query: emailAddress, limit: 100 });
      const match = data.find((invitation) => invitation.id === invitationId);
      return match ? summarizeInvitation(match) : null;
    },
  };
}
