import { AuthConfig, AuthErrorCode, BaseAuth } from '@nocobase/auth';
import { ClerkErrorCode, tokenHeader } from '../constants';
import type { ClerkApi } from './clerk-api';
import type { ConfigResult } from './config';
import { ClerkAuthError } from './errors';
import type { StaffInvitations } from './invitations';
import type { StaffAccess } from './staff-access';
import { verifyActiveClerkSession } from './token-verifier';
import type { VerifiedClerkSession } from './token-verifier';

export type ClerkServices = {
  config: () => ConfigResult;
  clerkApi: () => ClerkApi;
  staffAccess: StaffAccess;
  invitations: StaffInvitations;
};

/** An error carrying only what the browser may see (no `reason`). */
export function publicError(error: ClerkAuthError) {
  const result: any = new Error(error.message);
  result.status = error.status;
  result.code = error.code;
  return result;
}

/**
 * Clerk authenticator. Built per application by `createClerkAuth` so each app (including sub-apps of
 * the multi-app manager) uses its own plugin services.
 *
 * Sign-in: the browser sends the current Clerk session token in the `X-Clerk-Session-Token` header.
 * Nothing in the request body is used: no user id, email or role from the browser is trusted.
 */
export abstract class ClerkAuth extends BaseAuth {
  protected abstract get services(): ClerkServices;

  private verifiedSession?: VerifiedClerkSession;

  constructor(config: AuthConfig) {
    super({ ...config, userCollection: config.ctx.db.getCollection('users') });
  }

  async validate() {
    const configResult = this.services.config();
    if (configResult.ok === false) {
      this.ctx.logger.error('auth-clerk: not configured', { problems: configResult.problems });
      throw publicError(
        new ClerkAuthError(
          503,
          ClerkErrorCode.NOT_CONFIGURED,
          'Staff sign-in is not configured on the server. Use the administrator login.',
        ),
      );
    }
    try {
      const session = await verifyActiveClerkSession(
        this.ctx.get(tokenHeader),
        configResult.config,
        this.services.clerkApi(),
      );
      const { user } = await this.services.staffAccess.resolveLinkedUser(session.clerkUserId);
      this.verifiedSession = session;
      return user;
    } catch (error) {
      if (error instanceof ClerkAuthError) {
        this.ctx.logger.warn('auth-clerk: sign-in refused', { code: error.code, reason: error.reason });
        throw publicError(error);
      }
      throw error;
    }
  }

  async signIn() {
    const result = await super.signIn();
    const session = this.verifiedSession;
    try {
      const { signInTime } = await this.jwt.decode(result.token);
      const policy = await this.tokenController.getConfig();
      await this.services.staffAccess.recordSignIn({
        userId: result.user.get('id'),
        signInTime,
        clerkUserId: session.clerkUserId,
        clerkSessionId: session.sessionId,
        sessionTtlMs: policy?.sessionExpirationTime,
      });
    } catch (error: any) {
      // Without a binding the session could not be policed, so it must not be handed out.
      this.ctx.logger.error('auth-clerk: could not record sign-in', { error: error?.message });
      await this.jwt.block(result.token).catch(() => undefined);
      this.clearAuthCookies();
      this.ctx.throw(500, 'Sign-in could not be completed. Please try again.');
    }
    this.ctx.logger.info('auth-clerk: staff signed in', {
      userId: result.user.get('id'),
      clerkUserId: session.clerkUserId,
    });
    return result;
  }

  /**
   * Runs on every authenticated request (and websocket auth). On top of NocoBase's own token checks
   * the session must still have an active Clerk session, an enabled link and a staff role.
   */
  async checkToken() {
    const result = await super.checkToken();
    try {
      if (!result.signInTime) {
        throw new ClerkAuthError(
          401,
          ClerkErrorCode.SESSION_INACTIVE,
          'Your session has ended. Please sign in again.',
          'token has no signInTime',
        );
      }
      const binding = await this.services.staffAccess.findBinding(result.user.id, result.signInTime);
      if (!binding) {
        throw new ClerkAuthError(
          401,
          ClerkErrorCode.SESSION_INACTIVE,
          'Your session has ended. Please sign in again.',
          'no Clerk binding for token',
        );
      }
      await this.services.staffAccess.assertStillAuthorized(result.user.id, binding.get('clerkUserId'));
      await this.services.staffAccess.assertClerkSessionActive(binding);
    } catch (error) {
      if (!(error instanceof ClerkAuthError)) throw error;
      this.ctx.logger?.warn?.('auth-clerk: session rejected', {
        userId: result.user?.id,
        code: error.code,
        reason: error.reason,
      });
      await this.blockCurrentToken();
      this.ctx.throw(401, { message: error.message, code: AuthErrorCode.EXPIRED_SESSION });
    }
    return result;
  }

  private async blockCurrentToken() {
    const token = this.ctx.getBearerToken?.();
    if (token) {
      await this.jwt.block(token).catch(() => undefined);
    }
  }

  /**
   * Ends the NocoBase session (token blocked, cookies cleared) and revokes the Clerk session it came
   * from, so the same browser is not silently signed back in. Clerk revocation is best effort: if
   * Clerk is unreachable the NocoBase session still ends, and the sign-in page never re-uses a Clerk
   * session without the user asking it to.
   */
  async signOut() {
    const token = this.ctx.getBearerToken();
    if (token) {
      try {
        const { userId, signInTime } = await this.jwt.decode(token);
        const binding = userId && signInTime ? await this.services.staffAccess.findBinding(userId, signInTime) : null;
        if (binding && !binding.get('revokedAt')) {
          await this.services.staffAccess.markRevoked(binding.get('id'), 'signed out');
          try {
            await this.services.clerkApi().revokeSession(binding.get('clerkSessionId'));
          } catch (error: any) {
            this.ctx.logger.warn('auth-clerk: Clerk session revocation failed on sign-out', { error: error?.message });
          }
        }
      } catch {
        // An unverifiable token is not tied to any Clerk session we may touch.
      }
    }
    return super.signOut();
  }
}

export function createClerkAuth(getServices: () => ClerkServices): new (config: AuthConfig) => ClerkAuth {
  return class BoundClerkAuth extends ClerkAuth {
    protected get services() {
      return getServices();
    }
  };
}
