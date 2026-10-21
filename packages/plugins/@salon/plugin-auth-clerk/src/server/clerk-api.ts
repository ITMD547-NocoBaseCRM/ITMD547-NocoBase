import { createClerkClient } from '@clerk/backend';

export type ClerkUserSummary = {
  id: string;
  primaryEmail: string | null;
  name: string;
  banned: boolean;
  locked: boolean;
};

/** The few Clerk Backend API calls this plugin makes. Tests substitute a fake. */
export interface ClerkApi {
  getSessionStatus(sessionId: string): Promise<string>;
  revokeSession(sessionId: string): Promise<void>;
  getUser(clerkUserId: string): Promise<ClerkUserSummary | null>;
  findUsersByEmail(email: string): Promise<ClerkUserSummary[]>;
}

const summarize = (user: any): ClerkUserSummary => {
  const primary = user.emailAddresses?.find((item: any) => item.id === user.primaryEmailAddressId);
  return {
    id: user.id,
    primaryEmail: primary?.emailAddress ?? null,
    name: [user.firstName, user.lastName].filter(Boolean).join(' '),
    banned: !!user.banned,
    locked: !!user.locked,
  };
};

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
  };
}
