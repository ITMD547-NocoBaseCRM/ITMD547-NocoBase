import type { Database, Model } from '@nocobase/database';
import { invitationsCollection, linksCollection } from '../constants';
import { ClerkAuthError } from './errors';
import type { StaffAccess } from './staff-access';
import { StaffInvitations } from './invitations';

/**
 * Employee account onboarding: one CRM account per employee (`staff.userId`, unique), provisioned only by an
 * administrator and activated through the existing Clerk invitation flow.
 *
 * Status is derived from the real state on every read (linked user, business role, Clerk link, invitation), so it
 * can't drift. `employeeAccounts` only stores what can't be derived: the last provisioning error, a disabled flag
 * (with the roles taken away, for reactivation) and a manager's provisioning request. Every change is written to
 * `employeeAccountEvents`.
 *
 * Steps are idempotent: re-running provision reuses the employee's linked user, never creates a second user for an
 * employee, never re-invites while an invitation is pending, and never links by matching email.
 */

export const ACCOUNTS = 'employeeAccounts';
export const EVENTS = 'employeeAccountEvents';
/** Roles an administrator may give through onboarding. Admin is never assigned here. */
export const ASSIGNABLE_ROLES = ['staff', 'receptionist', 'manager'] as const;
const BUSINESS_ROLES = ['admin', 'manager', 'receptionist', 'staff'];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type AccountStatus =
  | 'not_provisioned'
  | 'invitation_pending'
  | 'invitation_expired'
  | 'pending_activation'
  | 'active'
  | 'failed'
  | 'disabled';

export class OnboardingError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
const fail = (status: number, message: string) => new OnboardingError(status, message);

interface Deps {
  db: Database;
  logger: any;
  staffAccess: StaffAccess;
  invitations: () => StaffInvitations;
  clerkConfigured: () => boolean;
  /** NocoBase caches each user's roles and default role; clear them after a change. */
  clearRoleCache: (userId: unknown) => Promise<void>;
}

export class EmployeeAccounts {
  private locks = new Map<string, Promise<unknown>>();

  constructor(private deps: Deps) {}

  private repo(name: string) {
    return this.deps.db.getRepository(name);
  }

  /** One provisioning operation per employee at a time (per server process; the DB constraints cover the rest). */
  private async exclusive<T>(staffId: string, fn: () => Promise<T>): Promise<T> {
    while (this.locks.has(staffId)) await this.locks.get(staffId)!.catch(() => undefined);
    const run = fn();
    this.locks.set(staffId, run);
    try {
      return await run;
    } finally {
      this.locks.delete(staffId);
    }
  }

  async log(staffId: unknown, action: string, actorId: unknown, detail: Record<string, unknown> = {}, userId?: unknown) {
    await this.repo(EVENTS).create({
      values: {
        staffId: String(staffId),
        userId: userId == null ? null : String(userId),
        action,
        actorId: actorId == null ? null : String(actorId),
        detail,
      },
    });
  }

  private async state(staffId: unknown) {
    const repo = this.repo(ACCOUNTS);
    const found = await repo.findOne({ filter: { staffId: String(staffId) } });
    return found || (await repo.create({ values: { staffId: String(staffId) } }));
  }

  private async setState(staffId: unknown, values: Record<string, unknown>) {
    const row = await this.state(staffId);
    await this.repo(ACCOUNTS).update({ filterByTk: row.get('id'), values });
  }

  private async loadStaff(staffId: unknown) {
    const staff = staffId ? await this.repo('staff').findOne({ filterByTk: staffId as any }) : null;
    if (!staff) throw fail(404, 'Employee not found.');
    return staff;
  }

  private async rolesOf(userId: unknown): Promise<string[]> {
    const rows = await this.repo('rolesUsers').find({ filter: { userId: userId as any } });
    return rows.map((r: Model) => r.get('roleName'));
  }

  // ---------------------------------------------------------------- status

  async list() {
    const staff = await this.repo('staff').find({ sort: ['firstName', 'lastName'] });
    const userIds = staff.map((s: Model) => s.get('userId')).filter((x: unknown) => x != null);
    const [users, rolesUsers, links, invitations, states, requests] = await Promise.all([
      userIds.length ? this.repo('users').find({ filter: { id: { $in: userIds } } }) : [],
      userIds.length ? this.repo('rolesUsers').find({ filter: { userId: { $in: userIds } } }) : [],
      userIds.length ? this.repo(linksCollection).find({ filter: { userId: { $in: userIds } } }) : [],
      userIds.length ? this.repo(invitationsCollection).find({ filter: { userId: { $in: userIds } }, sort: ['-createdAt'] }) : [],
      this.repo(ACCOUNTS).find({}),
      this.repo(EVENTS).find({ filter: { action: 'provisioning_requested' }, sort: ['-createdAt'] }),
    ]);
    const by = (rows: Model[], key: string) => {
      const map = new Map<string, Model>();
      for (const row of rows) if (!map.has(String(row.get(key)))) map.set(String(row.get(key)), row);
      return map;
    };
    const userMap = by(users, 'id');
    const linkMap = by(links, 'userId');
    const invMap = by(invitations, 'userId');
    const stateMap = by(states, 'staffId');
    const requestMap = by(requests, 'staffId');
    const rolesMap = new Map<string, string[]>();
    for (const ru of rolesUsers) {
      const key = String(ru.get('userId'));
      rolesMap.set(key, [...(rolesMap.get(key) || []), ru.get('roleName')]);
    }
    return staff.map((s: Model) => {
      const userId = s.get('userId') == null ? null : String(s.get('userId'));
      const user = userId ? userMap.get(userId) : undefined;
      const roles = userId ? rolesMap.get(userId) || [] : [];
      const link = userId ? linkMap.get(userId) : undefined;
      const invitation = userId ? invMap.get(userId) : undefined;
      const state = stateMap.get(String(s.get('id')));
      const invitationStatus = invitation ? StaffInvitations.effectiveStatus(invitation) : null;
      const status = EmployeeAccounts.statusOf({ userId, roles, link, invitationStatus, state });
      const request = requestMap.get(String(s.get('id')));
      return {
        staffId: String(s.get('id')),
        name: `${s.get('firstName') || ''} ${s.get('lastName') || ''}`.trim(),
        email: s.get('email') || null,
        jobTitle: s.get('role') || null,
        employment: s.get('active') || null,
        userId,
        user: user ? { id: userId, nickname: user.get('nickname'), username: user.get('username'), email: user.get('email') } : null,
        crmRoles: roles.filter((r) => BUSINESS_ROLES.includes(r)),
        status,
        invitation: invitation ? { id: String(invitation.get('id')), status: invitationStatus, expiresAt: invitation.get('expiresAt'), lastSentAt: invitation.get('lastSentAt') } : null,
        clerkLinked: !!link,
        clerkEnabled: link ? !!link.get('enabled') : null,
        lastSignInAt: link ? link.get('lastSignInAt') : null,
        lastError: state?.get('lastError') || null,
        lastErrorAt: state?.get('lastErrorAt') || null,
        requestedAt: request && status === 'not_provisioned' ? request.get('createdAt') : null,
      };
    });
  }

  static statusOf(x: { userId: string | null; roles: string[]; link?: Model; invitationStatus: string | null; state?: Model }): AccountStatus {
    if (x.state?.get('disabled')) return 'disabled';
    if (!x.userId) return x.state?.get('lastError') ? 'failed' : 'not_provisioned';
    const hasRole = x.roles.some((r) => BUSINESS_ROLES.includes(r));
    if (x.link && !x.link.get('enabled')) return 'disabled';
    if (x.link && hasRole) return 'active';
    if (x.invitationStatus === 'pending') return 'invitation_pending';
    if (x.state?.get('lastError')) return 'failed';
    if (x.invitationStatus === 'expired') return 'invitation_expired';
    return 'pending_activation';
  }

  /** Users an administrator may link to an employee: not root, not linked to another employee. */
  async candidates() {
    const linked = (await this.repo('staff').find({ filter: { userId: { $ne: null } } })).map((s: Model) => String(s.get('userId')));
    const users = await this.repo('users').find({ sort: ['id'] });
    const roles = await this.repo('rolesUsers').find({});
    const rolesBy = new Map<string, string[]>();
    for (const r of roles) rolesBy.set(String(r.get('userId')), [...(rolesBy.get(String(r.get('userId'))) || []), r.get('roleName')]);
    return users
      .filter((u: Model) => !linked.includes(String(u.get('id'))) && !(rolesBy.get(String(u.get('id'))) || []).includes('root'))
      .map((u: Model) => ({ id: String(u.get('id')), nickname: u.get('nickname'), username: u.get('username'), email: u.get('email'), roles: rolesBy.get(String(u.get('id'))) || [] }));
  }

  async events(staffId: unknown) {
    const rows = await this.repo(EVENTS).find({ filter: { staffId: String(staffId) }, sort: ['-createdAt'], limit: 200 });
    return rows.map((r: Model) => r.toJSON());
  }

  // ---------------------------------------------------------------- provisioning

  /**
   * Admin: give the employee a CRM account.
   *  - existingUserId: link this existing user (explicit choice; never inferred from email);
   *  - otherwise reuse the employee's linked user, or create a new one from the employee's name and email.
   * Then assign the chosen role (never removes roles, never assigns admin), link, and send a Clerk invitation unless
   * the user is already linked to Clerk or has an invitation pending. A Clerk failure leaves everything else in
   * place and marks the employee "Provisioning failed"; running provision again retries only what is missing.
   */
  async provision(input: { staffId: unknown; role: unknown; existingUserId?: unknown; sendInvite?: boolean }, actorId: unknown) {
    const role = String(input.role || '');
    if (!(ASSIGNABLE_ROLES as readonly string[]).includes(role)) throw fail(400, 'Choose Staff, Receptionist or Manager.');
    return this.exclusive(String(input.staffId), async () => {
      const staff = await this.loadStaff(input.staffId);
      const staffId = String(staff.get('id'));
      const current = staff.get('userId') == null ? null : String(staff.get('userId'));
      const wanted = input.existingUserId == null || input.existingUserId === '' ? null : String(input.existingUserId);
      if ((await this.state(staffId)).get('disabled')) throw fail(409, 'This account is disabled. Reactivate it instead.');
      if (current && wanted && current !== wanted) throw fail(409, 'This employee is already linked to another user. Unlink it first.');

      let userId = current || wanted;
      let created = false;
      if (userId && !current) {
        // Explicit link to an existing user.
        const user = await this.repo('users').findOne({ filterByTk: userId as any });
        if (!user) throw fail(404, 'User not found.');
        if ((await this.rolesOf(userId)).includes('root')) throw fail(400, 'The root account cannot be linked to an employee.');
        const other = await this.repo('staff').findOne({ filter: { userId: userId as any } });
        if (other) throw fail(409, `That user is already linked to ${other.get('firstName')} ${other.get('lastName')}.`);
      }
      if (!userId) {
        const email = String(staff.get('email') || '').trim().toLowerCase();
        if (!EMAIL.test(email)) throw fail(400, 'The employee needs a valid email address before an account can be created.');
        const sameEmail = await this.findByEmail('users', email);
        if (sameEmail) {
          throw fail(409, `A CRM user with this email already exists (${sameEmail.get('nickname') || sameEmail.get('username')}). If it is this employee, choose "Link existing user" and select it.`);
        }
        const user = await this.repo('users').create({
          values: {
            nickname: `${staff.get('firstName') || ''} ${staff.get('lastName') || ''}`.trim() || email,
            email,
            username: await this.freeUsername(email),
            roles: ['member'],
          },
        });
        userId = String(user.get('id'));
        created = true;
        await this.log(staffId, 'user_created', actorId, { email }, userId);
      }

      // Link first (unique constraint on staff.userId backs this up).
      if (!current) {
        await this.repo('staff').update({ filterByTk: staffId as any, values: { userId } });
        await this.log(staffId, 'linked', actorId, { created }, userId);
      }

      // Role: add the chosen one if missing; make it the default unless the user is an administrator.
      const roles = await this.rolesOf(userId);
      if (!roles.includes(role)) {
        await this.repo('rolesUsers').create({ values: { userId, roleName: role } });
        await this.log(staffId, 'role_assigned', actorId, { role }, userId);
      }
      if (!roles.includes('admin') && !roles.includes('root')) await this.setDefaultRole(userId, role);
      await this.deps.staffAccess.clearAccessCache(userId);
        await this.deps.clearRoleCache(userId);

      // Invitation through the existing Clerk flow.
      const result: Record<string, unknown> = { staffId, userId, created, invitation: null };
      const link = await this.repo(linksCollection).findOne({ filter: { userId: userId as any } });
      if (input.sendInvite !== false && !link) {
        const pending = (await this.repo(invitationsCollection).find({ filter: { userId: userId as any, status: 'pending' }, sort: ['-createdAt'] }))
          .find((i: Model) => new Date(i.get('expiresAt')).getTime() > Date.now());
        if (pending) {
          result.invitation = { id: String(pending.get('id')), status: 'pending', reused: true };
        } else {
          try {
            if (!this.deps.clerkConfigured()) throw fail(503, 'Clerk staff sign-in is not configured on the server.');
            const email = String(staff.get('email') || '').trim().toLowerCase();
            const sent = await this.deps.invitations().invite({ email, userId, note: `Employee ${staffId}` });
            result.invitation = { id: String((sent as any).id), status: 'pending' };
            await this.log(staffId, 'invitation_sent', actorId, { invitationId: String((sent as any).id) }, userId);
          } catch (error: any) {
            const message = error instanceof ClerkAuthError || error instanceof OnboardingError ? error.message : 'Clerk could not send the invitation.';
            await this.setState(staffId, { lastError: message, lastErrorAt: new Date() });
            await this.log(staffId, 'provisioning_failed', actorId, { step: 'invitation', message }, userId);
            throw fail(error?.status && error.status < 500 ? error.status : 502, `Account created and linked, but the invitation failed: ${message} Fix the problem and use Retry.`);
          }
        }
      }
      await this.setState(staffId, { lastError: null, lastErrorAt: null });
      return result;
    });
  }

  /** Admin: create the employee and provision the account in one step. The employee is kept if provisioning fails. */
  async createAndInvite(values: Record<string, any>, actorId: unknown) {
    const allowed = ['firstName', 'lastName', 'email', 'phone', 'role', 'specialty', 'active'];
    const employee: Record<string, unknown> = {};
    for (const k of allowed) if (values[k] !== undefined && values[k] !== '') employee[k] = values[k];
    if (!employee.firstName || !employee.lastName) throw fail(400, 'First and last name are required.');
    const email = String(employee.email || '').trim().toLowerCase();
    if (!EMAIL.test(email)) throw fail(400, 'A valid email is required to invite the employee.');
    employee.email = email;
    employee.active = employee.active || 'active';
    if (!(ASSIGNABLE_ROLES as readonly string[]).includes(String(values.crmRole))) throw fail(400, 'Choose Staff, Receptionist or Manager.');
    const dup = await this.findByEmail('staff', email);
    if (dup) throw fail(409, `An employee with this email already exists (${dup.get('firstName')} ${dup.get('lastName')}). Use "Invite to CRM" on that employee instead.`);
    const staff = await this.repo('staff').create({ values: employee });
    const staffId = String(staff.get('id'));
    await this.log(staffId, 'employee_created', actorId, { email });
    try {
      const result = await this.provision({ staffId, role: values.crmRole }, actorId);
      return { ...result, employeeCreated: true };
    } catch (error: any) {
      if (error instanceof OnboardingError) throw fail(error.status, `Employee saved. ${error.message}`);
      throw error;
    }
  }

  async resend(staffId: unknown, actorId: unknown) {
    const staff = await this.loadStaff(staffId);
    const userId = staff.get('userId');
    if (!userId) throw fail(409, 'This employee has no account yet. Use Invite to CRM.');
    const inv = await this.repo(invitationsCollection).findOne({ filter: { userId, status: 'pending' }, sort: ['-createdAt'] });
    if (!inv) throw fail(409, 'There is no open invitation to resend. Use Retry to send a new one.');
    const sent = await this.deps.invitations().resend(inv.get('id'));
    await this.setState(staff.get('id'), { lastError: null, lastErrorAt: null });
    await this.log(staff.get('id'), 'invitation_resent', actorId, { invitationId: String((sent as any)?.id || inv.get('id')) }, userId);
    return sent;
  }

  /** Admin: block access. Business roles are taken away (and remembered), the Clerk link is switched off. */
  async disable(staffId: unknown, actorId: unknown, opts: { reason?: string; offboard?: boolean } = {}) {
    return this.exclusive(String(staffId), async () => {
      const staff = await this.loadStaff(staffId);
      const userId = staff.get('userId');
      const removed: string[] = [];
      if (userId) {
        const roles = await this.rolesOf(userId);
        if (roles.includes('root') || roles.includes('admin')) throw fail(400, 'Administrator accounts are not disabled here. Remove the Admin role in Users & Permissions first.');
        for (const role of roles.filter((r) => ['manager', 'receptionist', 'staff'].includes(r))) {
          await this.repo('rolesUsers').destroy({ filter: { userId, roleName: role } });
          removed.push(role);
        }
        await this.setDefaultRole(userId, 'member');
        await this.repo(linksCollection).update({ filter: { userId }, values: { enabled: false } });
        await this.deps.staffAccess.clearAccessCache(userId);
        await this.deps.clearRoleCache(userId);
      }
      if (opts.offboard) await this.repo('staff').update({ filterByTk: staff.get('id'), values: { active: 'inactive' } });
      await this.setState(staff.get('id'), { disabled: true, disabledRoles: removed });
      await this.log(staff.get('id'), opts.offboard ? 'offboarded' : 'disabled', actorId, { removedRoles: removed, reason: opts.reason || null }, userId);
      return { removedRoles: removed };
    });
  }

  async reactivate(staffId: unknown, actorId: unknown, roleInput?: unknown) {
    return this.exclusive(String(staffId), async () => {
      const staff = await this.loadStaff(staffId);
      const state = await this.state(staff.get('id'));
      const userId = staff.get('userId');
      const remembered: string[] = (state.get('disabledRoles') as string[]) || [];
      const roles = roleInput ? [String(roleInput)] : remembered;
      if (!roles.length || !roles.every((r) => (ASSIGNABLE_ROLES as readonly string[]).includes(r))) throw fail(400, 'Choose the role to restore (Staff, Receptionist or Manager).');
      if (userId) {
        const have = await this.rolesOf(userId);
        for (const r of roles) if (!have.includes(r)) await this.repo('rolesUsers').create({ values: { userId, roleName: r } });
        await this.setDefaultRole(userId, roles[0]);
        await this.repo(linksCollection).update({ filter: { userId }, values: { enabled: true } });
        await this.deps.staffAccess.clearAccessCache(userId);
        await this.deps.clearRoleCache(userId);
      }
      if (staff.get('active') === 'inactive') await this.repo('staff').update({ filterByTk: staff.get('id'), values: { active: 'active' } });
      await this.setState(staff.get('id'), { disabled: false, disabledRoles: null });
      await this.log(staff.get('id'), 'reactivated', actorId, { restoredRoles: roles }, userId);
      return { restoredRoles: roles };
    });
  }

  /** Admin: remove a wrong employee ↔ user link. Requires a reason; the user and their roles are left as they are. */
  async unlink(staffId: unknown, actorId: unknown, reason: unknown) {
    const why = typeof reason === 'string' ? reason.trim() : '';
    if (why.length < 3) throw fail(400, 'Give a reason for unlinking (it is kept in the audit history).');
    return this.exclusive(String(staffId), async () => {
      const staff = await this.loadStaff(staffId);
      const userId = staff.get('userId');
      if (!userId) throw fail(409, 'This employee is not linked to a user.');
      await this.repo('staff').update({ filterByTk: staff.get('id'), values: { userId: null } });
      await this.deps.staffAccess.clearAccessCache(userId);
        await this.deps.clearRoleCache(userId);
      await this.log(staff.get('id'), 'unlinked', actorId, { reason: why }, userId);
      return { unlinkedUserId: String(userId) };
    });
  }

  /** Manager: ask an administrator to provision the account. */
  async requestProvisioning(staffId: unknown, actorId: unknown, note?: unknown) {
    const staff = await this.loadStaff(staffId);
    await this.log(staff.get('id'), 'provisioning_requested', actorId, { note: typeof note === 'string' ? note.slice(0, 500) : null });
    return { requested: true };
  }

  /** Clerk link created (invitation accepted or admin link): record the activation. */
  async onClerkLinked(userId: unknown) {
    const staff = await this.repo('staff').findOne({ filter: { userId: userId as any } });
    if (!staff) return;
    await this.setState(staff.get('id'), { lastError: null, lastErrorAt: null });
    await this.log(staff.get('id'), 'activated', null, {}, userId);
  }

  private async setDefaultRole(userId: unknown, role: string) {
    const rolesUsers = this.repo('rolesUsers');
    await rolesUsers.update({ filter: { userId: userId as any }, values: { default: false } });
    await rolesUsers.update({ filter: { userId: userId as any, roleName: role }, values: { default: true } });
  }

  /** Case-insensitive exact email match (only to refuse duplicates – never to link). */
  private async findByEmail(collection: string, email: string) {
    const rows = await this.repo(collection).find({ filter: { email: { $includes: email } } });
    return rows.find((r: Model) => String(r.get('email') || '').trim().toLowerCase() === email) || null;
  }

  private async freeUsername(email: string) {
    const base = email.split('@')[0].replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 40) || 'employee';
    for (let i = 0; i < 50; i += 1) {
      const name = i ? `${base}${i + 1}` : base;
      if (!(await this.repo('users').findOne({ filter: { username: name } }))) return name;
    }
    return `${base}${Date.now()}`;
  }
}
