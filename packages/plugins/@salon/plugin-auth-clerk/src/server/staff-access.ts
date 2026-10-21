import type { Cache } from '@nocobase/cache';
import type { Database, Model } from '@nocobase/database';
import { bindingsCollection, ClerkErrorCode, linksCollection } from '../constants';
import type { ClerkApi } from './clerk-api';
import type { ClerkConfig } from './config';
import { ClerkAuthError } from './errors';

type Logger = { info: (...args: any[]) => void; warn: (...args: any[]) => void; error: (...args: any[]) => void };

export type StaffAccessDeps = {
  db: Database;
  cache: Cache;
  logger: Logger;
  getConfig: () => ClerkConfig;
  getClerkApi: () => ClerkApi;
};

/** How long a passing link/role check is reused for the same user. Link changes clear it immediately. */
const ACCESS_CACHE_TTL_MS = 30_000;
const SESSION_KIND_CACHE_TTL_MS = 10 * 60_000;

const denied = (code: string, message: string, reason?: string) => new ClerkAuthError(403, code, message, reason);

/**
 * Authorization gate for Clerk-authenticated staff. Clerk only proves *who* someone is; whether they
 * may use the CRM is decided here from NocoBase data an administrator controls:
 *
 *  1. an enabled `clerkStaffLinks` row for the Clerk user id (no email matching, no auto-linking),
 *  2. the linked NocoBase user still exists,
 *  3. the user holds at least one staff role (by default admin / r_staff / r_receptionist; the
 *     default `member` role alone is not enough).
 *
 * Roles are only read, never written.
 */
export class StaffAccess {
  constructor(private deps: StaffAccessDeps) {}

  private get links() {
    return this.deps.db.getRepository(linksCollection);
  }

  private get bindings() {
    return this.deps.db.getRepository(bindingsCollection);
  }

  async clearAccessCache(userId: number | string) {
    await this.deps.cache.del(`access:${userId}`);
  }

  /** Sign-in: map a verified Clerk user id to the linked NocoBase user, or refuse. */
  async resolveLinkedUser(clerkUserId: string): Promise<{ user: Model; link: Model }> {
    const link = await this.links.findOne({ filter: { clerkUserId } });
    if (!link) {
      throw denied(
        ClerkErrorCode.NOT_LINKED,
        'This Clerk account is not linked to a staff account. Ask an administrator to link it.',
        `no link for ${clerkUserId}`,
      );
    }
    if (!link.get('enabled')) {
      throw denied(
        ClerkErrorCode.LINK_DISABLED,
        'Staff access for this account has been disabled.',
        `link ${link.get('id')} disabled`,
      );
    }
    const user = await this.deps.db.getRepository('users').findOne({ filterByTk: link.get('userId') });
    if (!user) {
      throw denied(
        ClerkErrorCode.NOT_LINKED,
        'The linked staff account no longer exists.',
        `user ${link.get('userId')} missing`,
      );
    }
    await this.assertStaffRole(user.get('id'));
    return { user, link };
  }

  async assertStaffRole(userId: number) {
    const { allowedRoles } = this.deps.getConfig();
    // The bootstrap superuser stays on the password login, whatever other roles it also holds.
    const rootRole = await this.deps.db.getRepository('rolesUsers').count({ filter: { userId, roleName: 'root' } });
    if (rootRole) {
      throw denied(
        ClerkErrorCode.NO_STAFF_ROLE,
        'This account must use the administrator password sign-in.',
        `user ${userId} holds the root role`,
      );
    }
    const staffRoles = await this.deps.db.getRepository('rolesUsers').count({
      filter: { userId, roleName: { $in: allowedRoles } },
    });
    if (!staffRoles) {
      throw denied(
        ClerkErrorCode.NO_STAFF_ROLE,
        'Your account does not have a staff role. Ask an administrator to assign one.',
        `user ${userId} has none of ${allowedRoles.join(',')}`,
      );
    }
  }

  /** Every authenticated request: the link must still be enabled, unchanged, and the role still held. */
  async assertStillAuthorized(userId: number, clerkUserId: string) {
    const cacheKey = `access:${userId}`;
    if ((await this.deps.cache.get(cacheKey)) === clerkUserId) {
      return;
    }
    const link = await this.links.findOne({ filter: { userId } });
    if (!link || link.get('clerkUserId') !== clerkUserId) {
      throw denied(ClerkErrorCode.NOT_LINKED, 'Staff access for this account was removed. Please sign in again.');
    }
    if (!link.get('enabled')) {
      throw denied(ClerkErrorCode.LINK_DISABLED, 'Staff access for this account has been disabled.');
    }
    await this.assertStaffRole(userId);
    await this.deps.cache.set(cacheKey, clerkUserId, ACCESS_CACHE_TTL_MS);
  }

  async recordSignIn(args: {
    userId: number;
    signInTime: number;
    clerkUserId: string;
    clerkSessionId: string;
    sessionTtlMs?: number;
  }) {
    const now = new Date();
    if (args.sessionTtlMs) {
      // Housekeeping: bindings for this user's sessions that can no longer be valid.
      await this.bindings.destroy({
        filter: { userId: args.userId, signInTime: { $lt: now.getTime() - args.sessionTtlMs } },
      });
    }
    await this.bindings.create({
      values: {
        userId: args.userId,
        signInTime: args.signInTime,
        clerkUserId: args.clerkUserId,
        clerkSessionId: args.clerkSessionId,
        lastCheckedAt: now,
      },
    });
    await this.deps.cache.set(`kind:${args.userId}:${args.signInTime}`, 'clerk', SESSION_KIND_CACHE_TTL_MS);
    await this.links.update({ filter: { userId: args.userId }, values: { lastSignInAt: now } });
  }

  async findBinding(userId: number, signInTime: number) {
    return this.bindings.findOne({ filter: { userId, signInTime } });
  }

  /** Whether the NocoBase session `(userId, signInTime)` was issued through Clerk. */
  async isClerkSession(userId: number, signInTime: number) {
    const key = `kind:${userId}:${signInTime}`;
    const cached = await this.deps.cache.get(key);
    if (cached) return cached === 'clerk';
    const isClerk = !!(await this.findBinding(userId, signInTime));
    await this.deps.cache.set(key, isClerk ? 'clerk' : 'other', SESSION_KIND_CACHE_TTL_MS);
    return isClerk;
  }

  private inflight = new Map<string, Promise<void>>();

  /**
   * Session policy: a NocoBase session issued from a Clerk session stays valid only while that Clerk
   * session is active. The Clerk session status is re-confirmed through the Backend API at most every
   * `CLERK_SESSION_RECHECK_SECONDS`; if Clerk reports it ended, revoked, expired or removed, the
   * NocoBase session is ended too. If Clerk cannot be reached, the last good confirmation is honoured
   * for up to three recheck intervals, then the session is ended (fail closed).
   */
  async assertClerkSessionActive(binding: Model) {
    if (binding.get('revokedAt')) {
      throw new ClerkAuthError(
        401,
        ClerkErrorCode.SESSION_INACTIVE,
        'Your session has ended. Please sign in again.',
        'binding revoked',
      );
    }
    const { sessionRecheckMs } = this.deps.getConfig();
    const lastCheckedAt = new Date(binding.get('lastCheckedAt')).getTime();
    if (Date.now() - lastCheckedAt < sessionRecheckMs) {
      return;
    }
    const key = String(binding.get('id'));
    if (!this.inflight.has(key)) {
      this.inflight.set(
        key,
        this.recheck(binding, lastCheckedAt, sessionRecheckMs).finally(() => this.inflight.delete(key)),
      );
    }
    await this.inflight.get(key);
  }

  private async recheck(binding: Model, lastCheckedAt: number, sessionRecheckMs: number) {
    let status: string;
    try {
      status = await this.deps.getClerkApi().getSessionStatus(binding.get('clerkSessionId'));
    } catch (error: any) {
      const withinGrace = Date.now() - lastCheckedAt < sessionRecheckMs * 3;
      this.deps.logger.warn('auth-clerk: could not confirm Clerk session status', {
        bindingId: binding.get('id'),
        withinGrace,
        error: error?.message,
      });
      if (withinGrace) return;
      throw new ClerkAuthError(
        401,
        ClerkErrorCode.UNAVAILABLE,
        'Your sign-in could not be confirmed. Please sign in again.',
        'Clerk unreachable',
      );
    }
    if (status === 'active') {
      await this.bindings.update({ filterByTk: binding.get('id'), values: { lastCheckedAt: new Date() } });
      return;
    }
    await this.markRevoked(binding.get('id'), `clerk session ${status}`);
    throw new ClerkAuthError(
      401,
      ClerkErrorCode.SESSION_INACTIVE,
      'Your Clerk session has ended. Please sign in again.',
      status,
    );
  }

  async markRevoked(bindingId: number | string, reason: string) {
    await this.bindings.update({
      filterByTk: bindingId,
      values: { revokedAt: new Date(), revokedReason: reason.slice(0, 200) },
    });
  }
}
