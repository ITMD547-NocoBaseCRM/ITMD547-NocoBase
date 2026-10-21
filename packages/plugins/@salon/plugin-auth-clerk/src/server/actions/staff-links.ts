import type { Context, Next } from '@nocobase/actions';
import { linksCollection } from '../../constants';
import type { ClerkServices } from '../clerk-auth';

const CLERK_USER_ID = /^user_[A-Za-z0-9]+$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Administrator actions on `clerkStaffLinks`. They are reachable only through the
 * `pm.auth-clerk` ACL snippet (administrators); plugin collections are not covered by role
 * data strategies, so staff and receptionist roles cannot read or change links.
 */
export function staffLinkActions(getServices: () => ClerkServices) {
  const requireClerk = (ctx: Context) => {
    const result = getServices().config();
    if (result.ok === false) {
      ctx.throw(503, `Clerk is not configured on the server: ${result.problems.join('; ')}`);
    }
    return getServices().clerkApi();
  };

  return {
    /** Explicit linking: an administrator picks both the Clerk user and the NocoBase user. */
    async create(ctx: Context, next: Next) {
      const { clerkUserId, userId, note } = ctx.action.params.values || {};
      if (typeof clerkUserId !== 'string' || !CLERK_USER_ID.test(clerkUserId.trim())) {
        ctx.throw(400, 'Enter a Clerk user ID (it starts with "user_").');
      }
      const id = clerkUserId.trim();
      const user = userId ? await ctx.db.getRepository('users').findOne({ filterByTk: userId }) : null;
      if (!user) {
        ctx.throw(400, 'Choose an existing NocoBase user.');
      }
      const repo = ctx.db.getRepository(linksCollection);
      if (await repo.findOne({ filter: { clerkUserId: id } })) {
        ctx.throw(409, 'This Clerk account is already linked to a staff account.');
      }
      if (await repo.findOne({ filter: { userId: user.get('id') } })) {
        ctx.throw(409, 'This NocoBase user is already linked to a Clerk account. Unlink it first.');
      }
      const api = requireClerk(ctx);
      let clerkUser;
      try {
        clerkUser = await api.getUser(id);
      } catch (error: any) {
        ctx.logger.warn('auth-clerk: Clerk user lookup failed', { error: error?.message });
        ctx.throw(502, 'Clerk could not be reached to confirm this account. Try again.');
      }
      if (!clerkUser) {
        ctx.throw(400, 'No Clerk user exists with this ID.');
      }
      ctx.body = await repo.create({
        values: {
          clerkUserId: id,
          userId: user.get('id'),
          enabled: true,
          clerkEmail: clerkUser.primaryEmail,
          note: typeof note === 'string' ? note.slice(0, 1000) : null,
        },
        context: ctx,
      });
      ctx.logger.info('auth-clerk: staff link created', {
        clerkUserId: id,
        userId: user.get('id'),
        by: ctx.state.currentUser?.id,
      });
      await next();
    },

    /** Only `enabled` and `note` can change; re-pointing a link means unlinking and linking again. */
    async update(ctx: Context, next: Next) {
      const { filterByTk } = ctx.action.params;
      const values = ctx.action.params.values || {};
      const allowed: Record<string, any> = {};
      if (typeof values.enabled === 'boolean') allowed.enabled = values.enabled;
      if (typeof values.note === 'string' || values.note === null)
        allowed.note = values.note ? values.note.slice(0, 1000) : null;
      if (!Object.keys(allowed).length || !filterByTk) {
        ctx.throw(400, 'Only "enabled" and "note" can be changed.');
      }
      const repo = ctx.db.getRepository(linksCollection);
      if (!(await repo.findOne({ filterByTk }))) {
        ctx.throw(404, 'Link not found.');
      }
      await repo.update({ filterByTk, values: allowed, context: ctx });
      ctx.body = await repo.findOne({ filterByTk, appends: ['user'] });
      ctx.logger.info('auth-clerk: staff link updated', {
        linkId: filterByTk,
        ...allowed,
        by: ctx.state.currentUser?.id,
      });
      await next();
    },

    /** Helps an administrator find the Clerk user id. Email is only used to search, never to link. */
    async lookupClerkUsers(ctx: Context, next: Next) {
      const query = String(ctx.action.params.query ?? ctx.action.params.values?.query ?? '').trim();
      const byId = CLERK_USER_ID.test(query);
      if (!byId && !EMAIL.test(query)) {
        ctx.throw(400, 'Search by an exact email address or a Clerk user ID.');
      }
      const api = requireClerk(ctx);
      let found;
      try {
        found = byId ? [await api.getUser(query)].filter(Boolean) : await api.findUsersByEmail(query);
      } catch (error: any) {
        ctx.logger.warn('auth-clerk: Clerk user lookup failed', { error: error?.message });
        ctx.throw(502, 'Clerk could not be reached. Try again.');
      }
      ctx.body = found;
      await next();
    },

    /** Non-secret configuration summary for the settings page. */
    async configStatus(ctx: Context, next: Next) {
      const result = getServices().config();
      ctx.body =
        result.ok === true
          ? {
              configured: true,
              issuer: result.config.issuer,
              authorizedParties: result.config.authorizedParties,
              allowedRoles: result.config.allowedRoles,
              networklessVerification: !!result.config.jwtKey,
              sessionRecheckSeconds: result.config.sessionRecheckMs / 1000,
            }
          : { configured: false, problems: result.problems };
      await next();
    },
  };
}
