import { AuthErrorCode } from '@nocobase/auth';
import type { Cache } from '@nocobase/cache';
import { Plugin } from '@nocobase/server';
import {
  aclSnippet,
  authType,
  bindingsCollection,
  ClerkErrorCode,
  defaultAuthenticatorName,
  invitationsCollection,
  linksCollection,
  namespace,
} from '../constants';
import { staffInvitationActions } from './actions/staff-invitations';
import { staffLinkActions } from './actions/staff-links';
import { createClerkApi } from './clerk-api';
import type { ClerkApi } from './clerk-api';
import { createClerkAuth } from './clerk-auth';
import type { ClerkServices } from './clerk-auth';
import { readClerkConfig } from './config';
import type { ConfigResult } from './config';
import { ClerkAuthError } from './errors';
import { StaffInvitations } from './invitations';
import sessionBindingsCollection from './schema/clerk-session-bindings';
import staffInvitationsCollection from './schema/clerk-staff-invitations';
import staffLinksCollection from './schema/clerk-staff-links';
import { StaffAccess } from './staff-access';

/** The only invitation actions that exist; NocoBase's generic CRUD on the table is refused. */
const INVITATION_ADMIN_ACTIONS = ['list', 'create', 'resend', 'revoke', 'destroy'];

export class PluginAuthClerkServer extends Plugin {
  private configResult: ConfigResult;
  private clerkApi?: ClerkApi;
  private cache: Cache;
  staffAccess: StaffAccess;
  invitations: StaffInvitations;

  /** Re-reads CLERK_* environment variables (they are otherwise read once at load). */
  reloadConfig() {
    this.configResult = readClerkConfig(process.env);
    this.clerkApi = undefined;
    return this.configResult;
  }

  /** For tests: replace the Clerk Backend API client. */
  setClerkApi(api: ClerkApi) {
    this.clerkApi = api;
  }

  private getClerkApi(): ClerkApi {
    if (!this.clerkApi) {
      if (this.configResult.ok === false) {
        throw new Error('Clerk is not configured');
      }
      this.clerkApi = createClerkApi(this.configResult.config.secretKey);
    }
    return this.clerkApi;
  }

  get services(): ClerkServices {
    return {
      config: () => this.configResult,
      clerkApi: () => this.getClerkApi(),
      staffAccess: this.staffAccess,
      invitations: this.invitations,
    };
  }

  private requireConfig() {
    if (this.configResult.ok === false) {
      throw new ClerkAuthError(503, ClerkErrorCode.NOT_CONFIGURED, 'Staff sign-in is not configured on the server.');
    }
    return this.configResult.config;
  }

  /**
   * Collections are registered here, not discovered from a `collections/` folder: the folder scan
   * natively imports `src/*.ts` under Vitest in this app-install layout. The result is the same as
   * NocoBase's `db.import` (including `origin`).
   */
  async beforeLoad() {
    for (const definition of [staffLinksCollection, sessionBindingsCollection, staffInvitationsCollection]) {
      this.db.collection({ ...definition, origin: namespace });
    }
  }

  async load() {
    this.reloadConfig();
    if (this.configResult.ok === false) {
      // Not fatal: the password login keeps working and the sign-in form explains the problem.
      this.app.logger.warn('auth-clerk: Clerk sign-in is not configured', { problems: this.configResult.problems });
    }

    this.cache = await this.app.cacheManager.createCache({ name: 'auth-clerk', prefix: 'auth-clerk', store: 'memory' });
    this.staffAccess = new StaffAccess({
      db: this.db,
      cache: this.cache,
      logger: this.app.logger,
      getConfig: () => this.requireConfig(),
      getClerkApi: () => this.getClerkApi(),
    });
    this.invitations = new StaffInvitations({
      db: this.db,
      logger: this.app.logger,
      staffAccess: this.staffAccess,
      getConfig: () => this.requireConfig(),
      getClerkApi: () => this.getClerkApi(),
    });

    this.app.authManager.registerTypes(authType, {
      auth: createClerkAuth(() => this.services),
      title: 'Clerk (staff)',
      // Only the publishable key reaches the browser. It is public by design.
      getPublicOptions: () => ({
        publishableKey: this.configResult.ok === true ? this.configResult.config.publishableKey : undefined,
        configured: this.configResult.ok === true,
      }),
    });

    const actions = staffLinkActions(() => this.services);
    this.app.resourceManager.registerActionHandlers({
      [`${linksCollection}:create`]: actions.create,
      [`${linksCollection}:update`]: actions.update,
      [`${linksCollection}:lookupClerkUsers`]: actions.lookupClerkUsers,
      [`${linksCollection}:configStatus`]: actions.configStatus,
    });
    const invitationActions = staffInvitationActions(() => this.services);
    this.app.resourceManager.registerActionHandlers({
      [`${invitationsCollection}:list`]: invitationActions.list,
      [`${invitationsCollection}:create`]: invitationActions.create,
      [`${invitationsCollection}:resend`]: invitationActions.resend,
      [`${invitationsCollection}:revoke`]: invitationActions.revoke,
      [`${invitationsCollection}:destroy`]: invitationActions.destroy,
      [`${invitationsCollection}:accept`]: invitationActions.accept,
    });
    this.app.acl.registerSnippet({
      name: aclSnippet,
      actions: [`${linksCollection}:*`, `${invitationsCollection}:*`],
    });
    // Invited staff have no NocoBase session yet; `accept` authenticates with the Clerk session token.
    this.app.acl.allow(invitationsCollection, 'accept', 'public');
    this.app.acl.use(this.adminOnlyResources(), { tag: 'auth-clerk-admin-only', before: 'allow-manager' });

    // Installs made before invitations existed have no invitations table, and this repo's Docker/EC2
    // deployments run `yarn start` (no `nocobase upgrade`). Create only this plugin's missing table;
    // nothing existing is altered.
    this.app.on('beforeStart', async () => {
      const collection = this.db.getCollection(invitationsCollection);
      if (collection && !(await collection.existsInDb())) {
        await collection.sync();
        this.app.logger.info(`auth-clerk: created the ${invitationsCollection} table`);
      }
    });

    const clearAccess = async (link: any) => this.staffAccess.clearAccessCache(link.get('userId'));
    this.db.on(`${linksCollection}.afterSave`, clearAccess);
    this.db.on(`${linksCollection}.afterDestroy`, clearAccess);

    this.app.dataSourceManager.use(this.crossAuthenticatorGuard(), {
      tag: 'auth-clerk-guard',
      after: 'auth',
      before: 'default',
    });
  }

  /**
   * Role data strategies ("view all collections", ...) apply to every resource while no
   * UI-managed collection exists, so the snippet alone is not a guarantee. This guard runs first in
   * the ACL chain: staff links require root or a role granted the `pm.auth-clerk` snippet, and the
   * session bindings are root-only.
   */
  private adminOnlyResources() {
    return async (ctx: any, next: () => Promise<any>) => {
      const resource = ctx.permission?.resourceName;
      if (resource === invitationsCollection) {
        const action = ctx.permission?.actionName;
        if (action === 'accept') {
          return next();
        }
        if (!INVITATION_ADMIN_ACTIONS.includes(action)) {
          ctx.throw(403, 'No permissions');
        }
      }
      if (resource === linksCollection || resource === bindingsCollection || resource === invitationsCollection) {
        const roles: string[] = ctx.state.currentRoles?.length
          ? ctx.state.currentRoles
          : [ctx.state.currentRole || 'anonymous'];
        const actionPath = `${resource}:${ctx.permission.actionName}`;
        const allowed =
          roles.includes('root') ||
          (resource !== bindingsCollection &&
            roles.some((name) => (this.app.acl as any).getRole(name)?.snippetAllowed(actionPath) === true));
        if (!allowed) {
          ctx.throw(403, 'No permissions');
        }
      }
      await next();
    };
  }

  /**
   * NocoBase tokens do not record which authenticator issued them, so a token issued here could be
   * replayed with `X-Authenticator: basic` and skip the Clerk session checks. This guard refuses a
   * Clerk-issued session presented through any other authenticator.
   */
  private crossAuthenticatorGuard() {
    return async (ctx: any, next: () => Promise<any>) => {
      const userId = ctx.state?.currentUser?.id;
      const usingClerk = ctx.auth?.authenticator?.authType === authType;
      if (userId && !usingClerk) {
        const signInTime = readSignInTime(ctx.getBearerToken?.());
        if (signInTime && (await this.staffAccess.isClerkSession(userId, signInTime))) {
          ctx.throw(401, {
            message: ctx.t('This session belongs to staff sign-in (Clerk). Please sign in again.', { ns: namespace }),
            code: AuthErrorCode.INVALID_TOKEN,
          });
        }
      }
      await next();
    };
  }

  async install() {
    const repo = this.db.getRepository('authenticators');
    if (!(await repo.findOne({ filter: { name: defaultAuthenticatorName } }))) {
      // Created disabled: an administrator enables it after configuring Clerk and linking staff.
      await repo.create({
        values: {
          name: defaultAuthenticatorName,
          authType,
          title: 'Staff sign-in',
          description: 'Sign in with Clerk (email/password, Google, password recovery). Linked staff accounts only.',
          enabled: false,
          options: {},
        },
      });
    }
  }
}

/** The token was already verified by the auth middleware; this only reads a claim from it. */
function readSignInTime(token: string | undefined): number | undefined {
  if (!token) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return typeof payload?.signInTime === 'number' ? payload.signInTime : undefined;
  } catch {
    return undefined;
  }
}

export default PluginAuthClerkServer;
