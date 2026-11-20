import type { Database } from '@nocobase/database';
import { invitationsCollection, linksCollection } from '../constants';

/**
 * Staff Access for non-administrators (Manager).
 *
 * Staff Access (snippet pm.auth-clerk) can link a Clerk sign-in to a NocoBase user and give business roles. For anyone
 * who is not acting as Admin or Root, this guard makes sure they can only work on ordinary staff accounts:
 *  - no linking, inviting, disabling, unlinking or re-enabling of accounts that hold Admin, Manager or Root;
 *  - no giving the Manager role through onboarding.
 * Otherwise a Manager could link their own Clerk sign-in to an Admin's account and sign in as that Admin.
 */
const PRIVILEGED = ['root', 'admin', 'manager'];
const PROTECTED_MESSAGE = 'Only an administrator can manage Admin and Manager accounts.';

export function delegatedAccessGuard(db: Database) {
  const rolesOfUser = async (userId: unknown): Promise<string[]> => {
    if (userId == null || userId === '') return [];
    const rows = await db.getRepository('rolesUsers').find({ filter: { userId: userId as any } });
    return rows.map((r: any) => r.get('roleName'));
  };
  const isProtected = async (userId: unknown) => (await rolesOfUser(userId)).some((r) => PRIVILEGED.includes(r));
  const staffUser = async (staffId: unknown) => {
    if (staffId == null || staffId === '') return null;
    const staff = await db.getRepository('staff').findOne({ filterByTk: staffId as any });
    return staff ? staff.get('userId') : null;
  };

  return async (ctx: any, next: () => Promise<any>) => {
    const resource = ctx.permission?.resourceName;
    if (resource !== linksCollection && resource !== invitationsCollection && resource !== 'employeeOnboarding') return next();
    const roles: string[] = ctx.state.currentRoles?.length ? ctx.state.currentRoles : [ctx.state.currentRole].filter(Boolean);
    if (roles.includes('root') || roles.includes('admin')) return next();

    const action = ctx.permission?.actionName;
    const params = ctx.action?.params || {};
    const v = { ...params, ...(params.values || {}) };
    const refuse = () => ctx.throw(403, PROTECTED_MESSAGE);

    if (resource === linksCollection) {
      if (action === 'create' && (await isProtected(v.userId))) refuse();
      if ((action === 'update' || action === 'destroy') && params.filterByTk) {
        const link = await db.getRepository(linksCollection).findOne({ filterByTk: params.filterByTk });
        if (link && (await isProtected(link.get('userId')))) refuse();
      }
    }
    if (resource === invitationsCollection) {
      if (action === 'create' && (await isProtected(v.userId))) refuse();
      if (['resend', 'revoke', 'destroy'].includes(action) && params.filterByTk) {
        const invitation = await db.getRepository(invitationsCollection).findOne({ filterByTk: params.filterByTk });
        if (invitation && (await isProtected(invitation.get('userId')))) refuse();
      }
    }
    if (resource === 'employeeOnboarding') {
      if (['provision', 'createAndInvite'].includes(action) && (v.role === 'manager' || v.crmRole === 'manager')) {
        ctx.throw(403, 'Only an administrator can give the Manager role.');
      }
      if (action === 'reactivate' && v.role === 'manager') ctx.throw(403, 'Only an administrator can give the Manager role.');
      if (action === 'provision' && (await isProtected(v.existingUserId))) refuse();
      if (['provision', 'resend', 'disable', 'reactivate', 'unlink'].includes(action)) {
        if (await isProtected(await staffUser(v.staffId))) refuse();
      }
      if (action === 'reactivate' && !v.role && v.staffId) {
        const state = await db.getRepository('employeeAccounts').findOne({ filter: { staffId: String(v.staffId) } });
        const remembered: string[] = (state && (state.get('disabledRoles') as string[])) || [];
        if (remembered.includes('manager')) ctx.throw(403, 'Only an administrator can give the Manager role.');
      }
    }
    return next();
  };
}

/** Roles this caller may give through onboarding (shown in the role picker; the server checks again). */
export function assignableRolesFor(roles: string[]) {
  return roles.includes('root') || roles.includes('admin') ? ['staff', 'receptionist', 'manager'] : ['staff', 'receptionist'];
}
