import type { Context, Next } from '@nocobase/actions';
import { ClerkErrorCode, tokenHeader } from '../../constants';
import type { ClerkServices } from '../clerk-auth';
import { publicError } from '../clerk-auth';
import { ClerkAuthError } from '../errors';
import { verifyActiveClerkSession } from '../token-verifier';

/** Admin actions are reachable only with the `pm.auth-clerk` snippet; `accept` is public (see plugin.ts). */
export function staffInvitationActions(getServices: () => ClerkServices) {
  /** Runs an invitation operation, turning plugin errors into safe HTTP errors. */
  const run = async (ctx: Context, operation: () => Promise<unknown>) => {
    const services = getServices();
    const configResult = services.config();
    if (configResult.ok === false) {
      ctx.throw(503, `Clerk is not configured on the server: ${configResult.problems.join('; ')}`);
    }
    try {
      ctx.body = await operation();
    } catch (error) {
      if (error instanceof ClerkAuthError) {
        ctx.logger.warn('auth-clerk: invitation request refused', { code: error.code, reason: error.reason });
        throw Object.assign(publicError(error), { expose: true });
      }
      throw error;
    }
  };

  return {
    async list(ctx: Context, next: Next) {
      ctx.body = await getServices().invitations.list();
      await next();
    },

    async create(ctx: Context, next: Next) {
      const values = ctx.action.params.values || {};
      await run(ctx, () => getServices().invitations.invite(values));
      await next();
    },

    async resend(ctx: Context, next: Next) {
      await run(ctx, () => getServices().invitations.resend(ctx.action.params.filterByTk));
      await next();
    },

    async revoke(ctx: Context, next: Next) {
      await run(ctx, () => getServices().invitations.revoke(ctx.action.params.filterByTk));
      await next();
    },

    /**
     * Public: called by the invitation page with the new Clerk account's session token in the
     * `X-Clerk-Session-Token` header. Body and query parameters are ignored entirely.
     */
    async accept(ctx: Context, next: Next) {
      await run(ctx, async () => {
        const services = getServices();
        const configResult = services.config();
        if (configResult.ok === false) {
          throw new ClerkAuthError(503, ClerkErrorCode.NOT_CONFIGURED, 'Staff sign-in is not configured.');
        }
        const session = await verifyActiveClerkSession(ctx.get(tokenHeader), configResult.config, services.clerkApi());
        const result = await services.invitations.accept(session);
        return { linked: true, alreadyLinked: result.alreadyLinked };
      });
      await next();
    },
  };
}
