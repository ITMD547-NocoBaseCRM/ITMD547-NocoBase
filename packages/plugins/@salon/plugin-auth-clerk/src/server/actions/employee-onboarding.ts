import type { Context, Next } from '@nocobase/actions';
import { ClerkAuthError } from '../errors';
import { EmployeeAccounts, OnboardingError } from '../employee-accounts';
import { assignableRolesFor } from '../delegated-access-guard';

export const ONBOARDING_RESOURCE = 'employeeOnboarding';
/** Manager (anyone who may edit employees) may read status and request provisioning. Everything else is Admin. */
export const ONBOARDING_VIEW_ACTIONS = ['list', 'requestProvisioning'];
export const ONBOARDING_ADMIN_ACTIONS = ['candidates', 'events', 'provision', 'createAndInvite', 'resend', 'disable', 'reactivate', 'unlink'];

export function employeeOnboardingActions(get: () => EmployeeAccounts, canAdmin: (ctx: Context) => boolean) {
  const run = (operation: (ctx: Context, v: any, actorId: unknown) => Promise<unknown>) => async (ctx: Context, next: Next) => {
    const v = { ...(ctx.action.params || {}), ...(ctx.action.params.values || {}) };
    const actorId = ctx.state?.currentUser?.id ?? null;
    try {
      ctx.body = await operation(ctx, v, actorId);
    } catch (error: any) {
      if (error instanceof OnboardingError || error instanceof ClerkAuthError) {
        ctx.throw(error.status || 400, error.message);
      }
      throw error;
    }
    await next();
  };
  return {
    list: run(async (ctx: any) => {
      const roles: string[] = ctx.state.currentRoles?.length ? ctx.state.currentRoles : [ctx.state.currentRole].filter(Boolean);
      return { rows: await get().list(), canManageAccounts: canAdmin(ctx), assignableRoles: assignableRolesFor(roles) };
    }),
    requestProvisioning: run((_c, v, a) => get().requestProvisioning(v.staffId, a, v.note)),
    candidates: run(() => get().candidates()),
    events: run((_c, v) => get().events(v.staffId)),
    provision: run((_c, v, a) => get().provision({ staffId: v.staffId, role: v.role, existingUserId: v.existingUserId, sendInvite: v.sendInvite !== false }, a)),
    createAndInvite: run((_c, v, a) => get().createAndInvite(v, a)),
    resend: run((_c, v, a) => get().resend(v.staffId, a)),
    disable: run((_c, v, a) => get().disable(v.staffId, a, { reason: v.reason, offboard: !!v.offboard })),
    reactivate: run((_c, v, a) => get().reactivate(v.staffId, a, v.role)),
    unlink: run((_c, v, a) => get().unlink(v.staffId, a, v.reason)),
  };
}
