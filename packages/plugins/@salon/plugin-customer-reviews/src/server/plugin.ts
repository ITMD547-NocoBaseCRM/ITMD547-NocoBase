import PluginWorkflowServer from '@nocobase/plugin-workflow';
import { Plugin } from '@nocobase/server';
import {
  ACL_SNIPPET,
  ADMIN_RESOURCE,
  DELIVERIES,
  INSTRUCTION_TYPE,
  INVITATIONS,
  MODERATION_EVENTS,
  PUBLIC_RESOURCE,
  REVIEWS,
  TOKEN_HEADER,
} from '../constants';
import { FixedWindowLimiter } from './core/rate-limit';
import { ReviewInvitationInstruction } from './instruction';
import { MODERATION_FLAG, ReviewError, ReviewService, SUBMISSION_FLAG } from './service';

/** Actions each review resource accepts. Everything else (create, update, destroy, ...) is refused for everyone. */
const MANAGED_ACTIONS: Record<string, string[]> = {
  [REVIEWS]: ['list', 'get', 'export'],
  [INVITATIONS]: ['list', 'get'],
  [DELIVERIES]: ['list', 'get'],
  [MODERATION_EVENTS]: ['list', 'get'],
  [ADMIN_RESOURCE]: ['appointmentSummary', 'sendNow', 'resend', 'revoke', 'regenerate', 'manualLink', 'moderate', 'listReviews', 'scores'],
};
const IMMUTABLE_REVIEW_FIELDS = ['appointmentId', 'customerId', 'staffId', 'invitationId', 'rating', 'comment', 'submittedAt'];
const MINUTES_15 = 15 * 60 * 1000;

export class PluginCustomerReviewsServer extends Plugin {
  private reviewService?: ReviewService;
  // Per client IP. Tokens have 256 bits of entropy, so these limits are about abuse, not guessing.
  private readonly inspectLimiter = new FixedWindowLimiter(60, MINUTES_15);
  private readonly submitLimiter = new FixedWindowLimiter(20, MINUTES_15);

  get reviews(): ReviewService {
    // Resolved lazily: the database handle is assigned after plugin fields are initialized.
    if (!this.reviewService) this.reviewService = new ReviewService(this.app);
    return this.reviewService;
  }

  async beforeLoad() {
    // Reviews are written only by the token-verified submission and changed only by moderation (status only).
    this.db.on(`${REVIEWS}.beforeCreate`, (model: any, options: any) => {
      if (!options?.transaction?.[SUBMISSION_FLAG]) throw new ReviewError('forbidden', 'Reviews can only be created by customers through a review link.', 403);
      const rating = Number(model.get('rating'));
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new ReviewError('rating', 'Rating must be an integer from 1 to 5.');
    });
    this.db.on(`${REVIEWS}.beforeUpdate`, (model: any, options: any) => {
      const changed: string[] = (model.changed() || []) as string[];
      if (changed.some((field) => IMMUTABLE_REVIEW_FIELDS.includes(field))) {
        throw new ReviewError('immutable', "A customer's rating and comment cannot be edited.", 403);
      }
      if (changed.includes('status') && !options?.transaction?.[MODERATION_FLAG]) {
        throw new ReviewError('forbidden', 'Use the moderation action to change a review status.', 403);
      }
      if (!['submitted', 'flagged'].includes(model.get('status'))) throw new ReviewError('status', 'Review status must be submitted or flagged.');
    });
    const noDelete = (what: string) => () => {
      throw new ReviewError('forbidden', `${what} are kept for audit and cannot be deleted.`, 403);
    };
    this.db.on(`${REVIEWS}.beforeDestroy`, noDelete('Customer reviews'));
    this.db.on(`${REVIEWS}.beforeBulkDestroy`, noDelete('Customer reviews'));
    this.db.on(`${MODERATION_EVENTS}.beforeUpdate`, noDelete('Moderation events'));
    this.db.on(`${MODERATION_EVENTS}.beforeDestroy`, noDelete('Moderation events'));
    this.db.on(`${MODERATION_EVENTS}.beforeBulkDestroy`, noDelete('Moderation events'));
  }

  async load() {
    this.registerPublicResource();
    this.registerStaffActions();
    this.registerAcl();
    this.registerWorkflowInstruction();

    // Deployments run `yarn start` without `nocobase upgrade`: create this plugin's missing tables on start.
    // Nothing that exists is altered, except adding the rating CHECK constraint once on PostgreSQL.
    this.app.on('beforeStart', async () => {
      for (const name of [REVIEWS, INVITATIONS, DELIVERIES, MODERATION_EVENTS]) {
        const collection = this.db.getCollection(name);
        if (collection && !(await collection.existsInDb())) {
          await collection.sync();
          this.app.logger.info(`customer-reviews: created the ${name} table`);
        }
      }
      await this.ensureRatingCheck();
    });
  }

  async install() {
    await this.ensureRatingCheck();
  }

  /** Database-level guard for the rating range (PostgreSQL). Other dialects rely on the model validation. */
  private async ensureRatingCheck() {
    if (!this.db.isPostgresCompatibleDialect()) return;
    const collection = this.db.getCollection(REVIEWS);
    if (!collection || !(await collection.existsInDb())) return;
    const table = collection.quotedTableName();
    try {
      await this.db.sequelize.query(
        `DO $$ BEGIN
           IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customer_reviews_rating_range') THEN
             ALTER TABLE ${table} ADD CONSTRAINT customer_reviews_rating_range CHECK (rating BETWEEN 1 AND 5);
           END IF;
         END $$;`,
      );
    } catch (error) {
      this.app.logger.warn('customer-reviews: could not add the rating CHECK constraint', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  // ------------------------------------------------------------------ public review page API

  private registerPublicResource() {
    const noStore = (ctx: any) => {
      ctx.set('Cache-Control', 'no-store, max-age=0');
      ctx.set('Pragma', 'no-cache');
      ctx.set('Referrer-Policy', 'no-referrer');
      ctx.set('X-Robots-Tag', 'noindex, nofollow');
    };
    const limit = (limiter: FixedWindowLimiter, ctx: any) => {
      const verdict = limiter.hit(String(ctx.request.ip || 'unknown'));
      if (!verdict.allowed) {
        ctx.set('Retry-After', String(verdict.retryAfterSeconds));
        ctx.throw(429, 'Too many requests. Please wait a few minutes and try again.');
      }
    };
    this.app.resourceManager.define({
      name: PUBLIC_RESOURCE,
      actions: {
        inspect: async (ctx: any, next: any) => {
          noStore(ctx);
          limit(this.inspectLimiter, ctx);
          ctx.body = await this.reviews.inspect(ctx.get(TOKEN_HEADER));
          await next();
        },
        submit: async (ctx: any, next: any) => {
          noStore(ctx);
          limit(this.submitLimiter, ctx);
          const values = ctx.action.params.values || {};
          // Only the rating and comment are read from the request. Any ids sent along are ignored.
          ctx.body = await this.reviews.submit(ctx.get(TOKEN_HEADER), { rating: values.rating, comment: values.comment });
          await next();
        },
      },
    });
  }

  // ------------------------------------------------------------------ staff actions

  private registerStaffActions() {
    const run = (operation: (ctx: any) => Promise<any>) => async (ctx: any, next: any) => {
      try {
        ctx.body = await operation(ctx);
      } catch (error) {
        if (error instanceof ReviewError) ctx.throw(error.status, error.message);
        throw error;
      }
      await next();
    };
    const userId = (ctx: any) => ctx.state?.currentUser?.id ?? null;
    const values = (ctx: any) => ctx.action.params.values || {};
    const param = (ctx: any, key: string) => values(ctx)[key] ?? ctx.action.params[key] ?? ctx.action.params.filterByTk;

    this.app.resourceManager.define({
      name: ADMIN_RESOURCE,
      actions: {
        appointmentSummary: run((ctx) => this.reviews.appointmentSummary(param(ctx, 'appointmentId'))),
        sendNow: run((ctx) => this.reviews.sendNow(param(ctx, 'appointmentId'), userId(ctx))),
        resend: run((ctx) => this.reviews.resendDelivery(String(param(ctx, 'deliveryId')), { userId: userId(ctx), trigger: 'resend', allowSent: true })),
        revoke: run((ctx) => this.reviews.revokeInvitation(param(ctx, 'invitationId'), userId(ctx), values(ctx).reason)),
        regenerate: run((ctx) => this.reviews.regenerateInvitation(param(ctx, 'invitationId'), userId(ctx))),
        manualLink: run(async (ctx) => {
          ctx.set('Cache-Control', 'no-store, max-age=0');
          return this.reviews.createManualLink(values(ctx).appointmentId, values(ctx).staffId, userId(ctx));
        }),
        listReviews: run((ctx) => this.reviews.listReviews({ ...ctx.action.params, ...values(ctx) })),
        moderate: run((ctx) => this.reviews.moderate(param(ctx, 'reviewId'), String(values(ctx).action || ''), values(ctx).reason, userId(ctx))),
        scores: run(async (ctx) => {
          // Same audience as the rest of Staff Performance: whoever may list appointments.
          const roles: string[] = ctx.state.currentRoles?.length ? ctx.state.currentRoles : [ctx.state.currentRole].filter(Boolean);
          const allowed = roles.includes('root') || roles.some((role) => !!this.app.acl.can({ role, resource: 'appointments', action: 'list' }));
          if (!allowed) ctx.throw(403, 'You do not have permission to view staff statistics.');
          const v = { ...ctx.action.params, ...values(ctx) };
          return this.reviews.scores({ from: v.from, to: v.to, staffId: v.staffId });
        }),
      },
    });
  }

  private registerAcl() {
    this.app.acl.registerSnippet({
      name: ACL_SNIPPET,
      actions: Object.keys(MANAGED_ACTIONS).map((resource) => `${resource}:*`),
    });
    this.app.acl.allow(PUBLIC_RESOURCE, ['inspect', 'submit'], 'public');
    this.app.acl.allow(ADMIN_RESOURCE, 'scores', 'loggedIn');
    // Role data strategies ("all actions on all collections") would otherwise open these tables to every role.
    // This guard runs first: only root and roles granted the snippet get in, and only for the listed actions.
    this.app.acl.use(
      async (ctx: any, next: () => Promise<any>) => {
        const resource = ctx.permission?.resourceName;
        const allowedActions = resource ? MANAGED_ACTIONS[resource] : undefined;
        if (allowedActions) {
          const action = ctx.permission?.actionName;
          if (!(resource === ADMIN_RESOURCE && action === 'scores')) {
            if (!allowedActions.includes(action)) ctx.throw(403, 'No permissions');
            const roles: string[] = ctx.state.currentRoles?.length ? ctx.state.currentRoles : [ctx.state.currentRole || 'anonymous'];
            const actionPath = `${resource}:${action}`;
            const allowed = roles.includes('root') || roles.some((name) => (this.app.acl as any).getRole(name)?.snippetAllowed(actionPath) === true);
            if (!allowed) ctx.throw(403, 'No permissions');
            if (resource === INVITATIONS && (action === 'list' || action === 'get')) ctx.action.mergeParams({ except: ['tokenHash'] });
          }
        }
        await next();
      },
      { tag: 'customer-reviews-guard', before: 'allow-manager' },
    );
  }

  private registerWorkflowInstruction() {
    const workflow: any = this.app.pm.get(PluginWorkflowServer as any);
    if (!workflow?.registerInstruction) {
      this.app.logger.warn('customer-reviews: the Workflow plugin is not enabled; the review node is unavailable.');
      return;
    }
    workflow.registerInstruction(INSTRUCTION_TYPE, new ReviewInvitationInstruction(workflow, () => this.reviews));
  }
}

export default PluginCustomerReviewsServer;
