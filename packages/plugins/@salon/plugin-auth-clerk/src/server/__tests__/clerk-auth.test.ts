import type { MockServer } from '@nocobase/test';
import { createRequire } from 'module';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bindingsCollection, invitationsCollection, linksCollection, namespace } from '../../constants';
import type { ClerkApi, ClerkInvitationSummary, ClerkUserSummary, CreateInvitationParams } from '../clerk-api';
import type PluginAuthClerkServer from '../plugin';
import { clerkEnv, makeSigningKeys, mintSessionToken } from './helpers';

// This repository is an app install, not the NocoBase source tree: @nocobase/test ships only its
// CommonJS entry, so load it with require. The plugin itself is loaded by the plugin manager from its
// package (run `yarn build @salon/plugin-auth-clerk` first), i.e. the tests exercise the built plugin.
const { createMockServer } = createRequire(__filename)('@nocobase/test');

// These tests install a fresh NocoBase into the configured database, which drops every table in it.
// Never let them near a shared database.
const LOCAL_HOST = /^(127\.0\.0\.1|localhost|::1)$/;
if (process.env.DB_DIALECT !== 'sqlite' && !LOCAL_HOST.test(process.env.DB_HOST || '')) {
  throw new Error(
    `Refusing to run Clerk integration tests against DB_HOST="${process.env.DB_HOST}". ` +
      'They reinstall (drop) the database. Point DB_* at a disposable local database (see the plugin README).',
  );
}

type FakeInvitation = ClerkInvitationSummary & CreateInvitationParams;

class FakeClerk implements ClerkApi {
  sessions = new Map<string, string>();
  users = new Map<string, ClerkUserSummary>();
  invitations = new Map<string, FakeInvitation>();
  revoked: string[] = [];
  revokedInvitations: string[] = [];
  unreachable = false;
  private seq = 0;

  addUser(id: string, primaryEmail: string, extra: Partial<ClerkUserSummary> = {}) {
    this.users.set(id, {
      id,
      primaryEmail,
      name: '',
      banned: false,
      locked: false,
      verifiedEmails: [primaryEmail.toLowerCase()],
      publicMetadata: {},
      createdAt: Date.now(),
      ...extra,
    });
  }
  /** What Clerk does when someone completes sign-up from an invitation link (ticket strategy). */
  acceptInvitation(invitationId: string, clerkUserId: string) {
    const invitation = this.invitations.get(invitationId);
    if (!invitation || invitation.status !== 'pending') throw new Error(`invitation ${invitationId} not pending`);
    invitation.status = 'accepted';
    this.addUser(clerkUserId, invitation.emailAddress, { publicMetadata: { ...invitation.publicMetadata } });
  }
  async createInvitation(params: CreateInvitationParams) {
    const exists =
      [...this.users.values()].some((u) => u.verifiedEmails.includes(params.emailAddress)) ||
      [...this.invitations.values()].some((i) => i.emailAddress === params.emailAddress && i.status === 'pending');
    if (exists) throw Object.assign(new Error('duplicate'), { status: 422, errors: [{ code: 'duplicate_record' }] });
    const invitation: FakeInvitation = { ...params, id: `inv_${++this.seq}`, status: 'pending', createdAt: Date.now() };
    this.invitations.set(invitation.id, invitation);
    return invitation;
  }
  async revokeInvitation(invitationId: string) {
    const invitation = this.invitations.get(invitationId);
    if (!invitation || invitation.status !== 'pending') {
      throw Object.assign(new Error('not revocable'), { status: 400 });
    }
    invitation.status = 'revoked';
    this.revokedInvitations.push(invitationId);
  }
  async findInvitation(invitationId: string, emailAddress: string) {
    const invitation = this.invitations.get(invitationId);
    return invitation && invitation.emailAddress === emailAddress ? invitation : null;
  }
  async getSessionStatus(sessionId: string) {
    if (this.unreachable) throw new Error('network down');
    return this.sessions.get(sessionId) ?? 'not_found';
  }
  async revokeSession(sessionId: string) {
    this.revoked.push(sessionId);
    this.sessions.set(sessionId, 'revoked');
  }
  async getUser(id: string) {
    return this.users.get(id) ?? null;
  }
  async findUsersByEmail(email: string) {
    return [...this.users.values()].filter((user) => user.primaryEmail === email);
  }
}

describe('Clerk staff authentication', () => {
  const keys = makeSigningKeys();
  const savedEnv = { ...process.env };
  let app: MockServer;
  let plugin: PluginAuthClerkServer;
  let clerk: FakeClerk;
  let users: Record<string, any>;
  let root: any;

  const repo = (name: string) => app.db.getRepository(name);
  const token = (sub: string, sid: string, extra: Partial<Parameters<typeof mintSessionToken>[0]> = {}) => {
    clerk.sessions.set(sid, clerk.sessions.get(sid) ?? 'active');
    return mintSessionToken({ privatePem: keys.privatePem, sub, sid, ...extra });
  };
  const signIn = (clerkToken?: string, body: Record<string, any> = {}) => {
    const request = app.agent().post('/auth:signIn').set('X-Authenticator', 'clerk');
    if (clerkToken) request.set('X-Clerk-Session-Token', clerkToken);
    return request.send(body);
  };
  const check = (nocobaseToken: string, authenticator = 'clerk') =>
    app
      .agent()
      .get('/auth:check')
      .set('Authorization', `Bearer ${nocobaseToken}`)
      .set('X-Authenticator', authenticator);
  const errorOf = (res: any) => res.body?.errors?.[0]?.message || '';
  const rolesOf = async (userId: number) =>
    (await repo('rolesUsers').find({ filter: { userId }, raw: true })).map((row: any) => row.roleName).sort();
  const link = (clerkUserId: string, user: any, enabled = true) =>
    repo(linksCollection).create({ values: { clerkUserId, userId: user.id, enabled } });

  beforeAll(async () => {
    Object.assign(process.env, clerkEnv(keys.publicPem));
    app = await createMockServer({
      // The mock server disables ACL unless asked; permissions are part of what is under test.
      acl: true,
      plugins: [
        'error-handler',
        'field-sort',
        'users',
        'auth',
        'acl',
        'data-source-main',
        'data-source-manager',
        'system-settings',
        '@salon/plugin-auth-clerk',
      ],
    });
    plugin = (app.pm.get(namespace) as unknown) as PluginAuthClerkServer;
    expect(plugin).toBeTruthy();
    await repo('authenticators').update({ filter: { name: 'clerk' }, values: { enabled: true } });
    // A broad "all collections" data strategy, as a CRM staff role typically has. It must still not
    // reach the plugin's tables.
    await repo('roles').create({
      values: { name: 'r_staff', title: 'Staff', strategy: { actions: ['view', 'create', 'update', 'destroy'] } },
    });
    await repo('roles').create({ values: { name: 'r_receptionist', title: 'Receptionist' } });
    const make = (username: string, roles: string[]) =>
      repo('users').create({ values: { username, email: `${username}@salon.test`, nickname: username, roles } });
    users = {
      staff: await make('staff', ['r_staff', 'member']),
      receptionist: await make('receptionist', ['r_receptionist']),
      memberOnly: await make('memberonly', ['member']),
      lookalike: await make('lookalike', ['r_staff']),
      linkTarget: await make('linktarget', ['r_staff']),
      newHire: await make('newhire', ['r_staff', 'member']),
      newHire2: await make('newhire2', ['r_receptionist']),
    };
    root = await repo('users').findOne({ filter: { 'roles.name': 'root' } });
  });

  afterAll(async () => {
    process.env = savedEnv;
    await app?.destroy();
  });

  beforeEach(async () => {
    clerk = new FakeClerk();
    plugin.setClerkApi(clerk);
    await repo(linksCollection).destroy({ truncate: true });
    await repo(bindingsCollection).destroy({ truncate: true });
    await repo(invitationsCollection).destroy({ truncate: true });
  });

  describe('invalid or expired credentials', () => {
    it('rejects a request without a Clerk token', async () => {
      const res = await signIn();
      expect(res.status).toBe(401);
      expect(res.body.data?.token).toBeUndefined();
    });

    it('rejects a token signed by another key', async () => {
      await link('user_staff', users.staff);
      const forged = mintSessionToken({
        privatePem: makeSigningKeys().privatePem,
        sub: 'user_staff',
        sid: 'sess_forged',
      });
      clerk.sessions.set('sess_forged', 'active');
      const res = await signIn(forged);
      expect(res.status).toBe(401);
      expect(res.body.data?.token).toBeUndefined();
    });

    it('rejects an expired token', async () => {
      await link('user_staff', users.staff);
      const res = await signIn(token('user_staff', 'sess_exp', { expiresInSeconds: -300 }));
      expect(res.status).toBe(401);
    });

    it('rejects a token issued for another origin', async () => {
      await link('user_staff', users.staff);
      const res = await signIn(token('user_staff', 'sess_azp', { azp: 'https://evil.example' }));
      expect(res.status).toBe(401);
    });

    it('rejects a valid token whose Clerk session has already ended', async () => {
      await link('user_staff', users.staff);
      clerk.sessions.set('sess_ended', 'ended');
      const res = await signIn(token('user_staff', 'sess_ended'));
      expect(res.status).toBe(401);
      expect(errorOf(res)).toMatch(/no longer active/);
    });

    it('refuses sign-in when Clerk is not configured, and keeps the server healthy', async () => {
      const secret = process.env.CLERK_SECRET_KEY;
      delete process.env.CLERK_SECRET_KEY;
      plugin.reloadConfig();
      plugin.setClerkApi(clerk);
      try {
        const res = await signIn(token('user_staff', 'sess_cfg'));
        expect(res.status).toBe(503);
        expect(errorOf(res)).toMatch(/not configured/);
      } finally {
        process.env.CLERK_SECRET_KEY = secret;
        plugin.reloadConfig();
        plugin.setClerkApi(clerk);
      }
    });
  });

  describe('staff-only access and linking', () => {
    it('signs in a linked staff member through the NocoBase session lifecycle', async () => {
      await link('user_staff', users.staff);
      const res = await signIn(token('user_staff', 'sess_ok'));
      expect(res.status).toBe(200);
      expect(res.body.data.user.id).toBe(users.staff.id);
      expect(res.body.data.token).toEqual(expect.any(String));
      expect((await check(res.body.data.token)).status).toBe(200);
      const binding = await repo(bindingsCollection).findOne({ filter: { userId: users.staff.id } });
      expect(binding.get('clerkSessionId')).toBe('sess_ok');
      expect(
        (await repo(linksCollection).findOne({ filter: { userId: users.staff.id } })).get('lastSignInAt'),
      ).toBeTruthy();
    });

    it('signs in a linked receptionist', async () => {
      await link('user_recep', users.receptionist);
      const res = await signIn(token('user_recep', 'sess_recep'));
      expect(res.status).toBe(200);
      expect(res.body.data.user.id).toBe(users.receptionist.id);
    });

    it('refuses an arbitrary Clerk sign-up that has no link', async () => {
      const usersBefore = await repo('users').count();
      const res = await signIn(token('user_stranger', 'sess_stranger'));
      expect(res.status).toBe(403);
      expect(errorOf(res)).toMatch(/not linked/);
      expect(await repo('users').count()).toBe(usersBefore);
    });

    it('never links by matching email', async () => {
      clerk.addUser('user_lookalike', users.lookalike.email);
      const res = await signIn(token('user_lookalike', 'sess_lookalike'));
      expect(res.status).toBe(403);
      expect(await repo(linksCollection).count()).toBe(0);
    });

    it('ignores user ids, emails and roles supplied by the browser', async () => {
      const res = await signIn(token('user_stranger', 'sess_spoof'), {
        userId: users.staff.id,
        email: users.staff.email,
        uuid: 'user_staff',
        roleName: 'admin',
      });
      expect(res.status).toBe(403);
    });

    it('refuses a linked user who has only the default member role', async () => {
      await link('user_member', users.memberOnly);
      const res = await signIn(token('user_member', 'sess_member'));
      expect(res.status).toBe(403);
      expect(errorOf(res)).toMatch(/staff role/);
    });

    it('preserves roles and never grants administrator privileges', async () => {
      const before = await rolesOf(users.staff.id);
      await link('user_staff', users.staff);
      const res = await signIn(token('user_staff', 'sess_roles'));
      expect(res.status).toBe(200);
      const after = await rolesOf(users.staff.id);
      expect(after).toEqual(before);
      expect(after).not.toContain('admin');
      expect(after).not.toContain('root');
    });
  });

  describe('disabled and revoked access', () => {
    it('refuses sign-in through a disabled link', async () => {
      await link('user_staff', users.staff, false);
      const res = await signIn(token('user_staff', 'sess_disabled'));
      expect(res.status).toBe(403);
      expect(errorOf(res)).toMatch(/disabled/);
    });

    it('ends an existing session as soon as the link is disabled', async () => {
      const staffLink = await link('user_staff', users.staff);
      const { token: nb } = (await signIn(token('user_staff', 'sess_live'))).body.data;
      expect((await check(nb)).status).toBe(200);
      await repo(linksCollection).update({ filterByTk: staffLink.get('id'), values: { enabled: false } });
      expect((await check(nb)).status).toBe(401);
    });

    it('ends an existing session when the staff role is removed', async () => {
      await link('user_recep', users.receptionist);
      const { token: nb } = (await signIn(token('user_recep', 'sess_role'))).body.data;
      await repo('rolesUsers').destroy({ filter: { userId: users.receptionist.id, roleName: 'r_receptionist' } });
      await plugin.staffAccess.clearAccessCache(users.receptionist.id);
      try {
        expect((await check(nb)).status).toBe(401);
      } finally {
        await repo('rolesUsers').create({ values: { userId: users.receptionist.id, roleName: 'r_receptionist' } });
      }
    });

    it('ends the NocoBase session once Clerk reports the Clerk session revoked', async () => {
      await link('user_staff', users.staff);
      const { token: nb } = (await signIn(token('user_staff', 'sess_revoke'))).body.data;
      clerk.sessions.set('sess_revoke', 'revoked');
      // Within the recheck interval the last confirmation is still trusted...
      expect((await check(nb)).status).toBe(200);
      // ...after it, Clerk is asked again and the session ends.
      await repo(bindingsCollection).update({
        filter: { clerkSessionId: 'sess_revoke' },
        values: { lastCheckedAt: new Date(Date.now() - 120_000) },
      });
      expect((await check(nb)).status).toBe(401);
      const binding = await repo(bindingsCollection).findOne({ filter: { clerkSessionId: 'sess_revoke' } });
      expect(binding.get('revokedAt')).toBeTruthy();
    });

    it('fails closed when Clerk stays unreachable past the grace period', async () => {
      await link('user_staff', users.staff);
      const { token: nb } = (await signIn(token('user_staff', 'sess_down'))).body.data;
      clerk.unreachable = true;
      const age = async (ms: number) =>
        repo(bindingsCollection).update({
          filter: { clerkSessionId: 'sess_down' },
          values: { lastCheckedAt: new Date(Date.now() - ms) },
        });
      await age(90_000); // past the 60s recheck, inside the 3x grace
      expect((await check(nb)).status).toBe(200);
      await age(10 * 60_000);
      expect((await check(nb)).status).toBe(401);
    });

    it('does not accept a Clerk-issued session through another authenticator', async () => {
      await link('user_staff', users.staff);
      const { token: nb } = (await signIn(token('user_staff', 'sess_cross'))).body.data;
      expect((await check(nb, 'basic')).status).toBe(401);
    });

    it('keeps the password login working as the administrator fallback', async () => {
      const agent = await app.agent().login(users.staff);
      expect((await agent.get('/auth:check')).status).toBe(200);
    });
  });

  describe('sign-out', () => {
    it('ends the NocoBase session and revokes the Clerk session', async () => {
      await link('user_staff', users.staff);
      const { token: nb } = (await signIn(token('user_staff', 'sess_out'))).body.data;
      const res = await app
        .agent()
        .post('/auth:signOut')
        .set('Authorization', `Bearer ${nb}`)
        .set('X-Authenticator', 'clerk');
      expect(res.status).toBe(200);
      expect(clerk.revoked).toEqual(['sess_out']);
      expect((await check(nb)).status).toBe(401);
    });
  });

  describe('administrator linking API', () => {
    const asRoot = async () => app.agent().login(root, 'root');

    it('links only after confirming the Clerk user exists', async () => {
      const agent = await asRoot();
      const missing = await agent
        .post('/clerkStaffLinks:create')
        .send({ clerkUserId: 'user_nobody', userId: users.linkTarget.id });
      expect(missing.status).toBe(400);

      clerk.addUser('user_target', 'target@clerk.test');
      const ok = await agent
        .post('/clerkStaffLinks:create')
        .send({ clerkUserId: 'user_target', userId: users.linkTarget.id });
      expect(ok.status).toBe(200);
      expect(ok.body.data).toMatchObject({
        clerkUserId: 'user_target',
        userId: users.linkTarget.id,
        enabled: true,
        clerkEmail: 'target@clerk.test',
      });

      const duplicate = await agent
        .post('/clerkStaffLinks:create')
        .send({ clerkUserId: 'user_target', userId: users.staff.id });
      expect(duplicate.status).toBe(409);
    });

    it('only lets administrators toggle enabled/note, never re-point a link', async () => {
      const agent = await asRoot();
      const staffLink = await link('user_staff', users.staff);
      const repoint = await agent
        .post(`/clerkStaffLinks:update?filterByTk=${staffLink.get('id')}`)
        .send({ clerkUserId: 'user_other' });
      expect(repoint.status).toBe(400);
      const disable = await agent
        .post(`/clerkStaffLinks:update?filterByTk=${staffLink.get('id')}`)
        .send({ enabled: false });
      expect(disable.status).toBe(200);
      expect((await repo(linksCollection).findOne({ filterByTk: staffLink.get('id') })).get('enabled')).toBe(false);
    });

    it('denies link management to staff without the settings permission', async () => {
      const agent = await app.agent().login(users.staff, 'r_staff');
      clerk.addUser('user_target', 'target@clerk.test');
      expect((await agent.get('/clerkStaffLinks:list')).status).toBe(403);
      expect(
        (await agent.post('/clerkStaffLinks:create').send({ clerkUserId: 'user_target', userId: users.staff.id }))
          .status,
      ).toBe(403);
      expect((await agent.get('/clerkSessionBindings:list')).status).toBe(403);
    });

    it('keeps the tables closed even when role data strategies cover them', async () => {
      // Simulates the case where "all collections" strategies reach plugin tables.
      app.acl.appendStrategyResource(linksCollection);
      app.acl.appendStrategyResource(bindingsCollection);
      try {
        const agent = await app.agent().login(users.staff, 'r_staff');
        expect((await agent.get('/clerkStaffLinks:list')).status).toBe(403);
        expect((await agent.get('/clerkSessionBindings:list')).status).toBe(403);
      } finally {
        app.acl.removeStrategyResource(linksCollection);
        app.acl.removeStrategyResource(bindingsCollection);
      }
    });

    it('lets an Owner/Admin (admin role, settings permission) manage links but not read session bindings', async () => {
      const owner = await repo('users').create({
        values: { username: 'owner', email: 'owner@salon.test', roles: ['admin'] },
      });
      const agent = await app.agent().login(owner, 'admin');
      expect((await agent.get('/clerkStaffLinks:list')).status).toBe(200);
      expect((await agent.get('/clerkSessionBindings:list')).status).toBe(403);
    });
  });

  describe('root-account restriction', () => {
    it('refuses Clerk sign-in for the root user, even though it also holds an allowed role', async () => {
      // NocoBase's bootstrap root user also has "admin", which is an allowed staff role.
      expect(await rolesOf(root.id)).toEqual(expect.arrayContaining(['root', 'admin']));
      await link('user_rootplus', root);
      const res = await signIn(token('user_rootplus', 'sess_rootplus'));
      expect(res.status).toBe(403);
      expect(errorOf(res)).toMatch(/password sign-in/);
    });
  });

  describe('invitation-only registration', () => {
    const asRoot = async () => app.agent().login(root, 'root');
    const invite = async (values: Record<string, any>) =>
      (await asRoot()).post('/clerkStaffInvitations:create').send(values);
    const accept = (clerkToken: string, body: Record<string, any> = {}) =>
      app.agent().post('/clerkStaffInvitations:accept').set('X-Clerk-Session-Token', clerkToken).send(body);
    const invitationRow = (id: number) => repo(invitationsCollection).findOne({ filterByTk: id });
    /** Invite, then let the invitee complete Clerk's ticket sign-up. */
    const inviteAndRegister = async (user: any, email: string, clerkUserId: string) => {
      const res = await invite({ email, userId: user.id });
      expect(res.status).toBe(200);
      const row = await invitationRow(res.body.data.id);
      clerk.acceptInvitation(row.get('clerkInvitationId'), clerkUserId);
      return row;
    };

    it('stores the pairing server-side and sends a Clerk invitation back to this CRM', async () => {
      const res = await invite({ email: '  New.Hire@Salon.test ', userId: users.newHire.id });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        email: 'new.hire@salon.test',
        userId: users.newHire.id,
        status: 'pending',
      });
      expect(res.body.data.nonce).toBeUndefined();

      const row = await invitationRow(res.body.data.id);
      const sent = clerk.invitations.get(row.get('clerkInvitationId'));
      expect(sent).toMatchObject({
        emailAddress: 'new.hire@salon.test',
        redirectUrl: 'http://localhost:13000/staff-invite',
        expiresInDays: 7,
        publicMetadata: { nocobaseInvitation: { id: row.get('id'), nonce: row.get('nonce') } },
      });
      // The NocoBase user is never sent to Clerk.
      expect(JSON.stringify(sent)).not.toContain(`"userId"`);

      const list = await (await asRoot()).get('/clerkStaffInvitations:list');
      expect(list.status).toBe(200);
      expect(list.body.data[0].nonce).toBeUndefined();
    });

    it('refuses root, users without a staff role, linked users and duplicate pending invitations', async () => {
      expect((await invite({ email: 'root@salon.test', userId: root.id })).status).toBe(400);
      expect((await invite({ email: 'm@salon.test', userId: users.memberOnly.id })).status).toBe(400);
      expect((await invite({ email: 'not-an-email', userId: users.newHire.id })).status).toBe(400);

      await link('user_existing', users.staff);
      expect((await invite({ email: 's@salon.test', userId: users.staff.id })).status).toBe(409);

      expect((await invite({ email: 'a@salon.test', userId: users.newHire.id })).status).toBe(200);
      expect((await invite({ email: 'b@salon.test', userId: users.newHire.id })).status).toBe(409);
      expect((await invite({ email: 'a@salon.test', userId: users.newHire2.id })).status).toBe(409);

      // Clerk already has an account for the address: invite is refused, nothing left behind.
      clerk.addUser('user_has_account', 'taken@salon.test');
      expect((await invite({ email: 'taken@salon.test', userId: users.newHire2.id })).status).toBe(409);
      expect(await repo(invitationsCollection).count({ filter: { email: 'taken@salon.test' } })).toBe(0);
    });

    it('lets only administrators manage invitations and refuses generic CRUD on the table', async () => {
      const staff = await app.agent().login(users.staff, 'r_staff');
      expect((await staff.get('/clerkStaffInvitations:list')).status).toBe(403);
      expect(
        (await staff.post('/clerkStaffInvitations:create').send({ email: 'x@salon.test', userId: users.staff.id }))
          .status,
      ).toBe(403);

      const res = await invite({ email: 'crud@salon.test', userId: users.newHire.id });
      const id = res.body.data.id;
      expect((await staff.post(`/clerkStaffInvitations:revoke?filterByTk=${id}`)).status).toBe(403);
      expect((await staff.post(`/clerkStaffInvitations:resend?filterByTk=${id}`)).status).toBe(403);
      expect((await staff.post(`/clerkStaffInvitations:destroy?filterByTk=${id}`)).status).toBe(403);
      const rootAgent = await asRoot();
      expect(
        (await rootAgent.post(`/clerkStaffInvitations:update?filterByTk=${id}`).send({ status: 'accepted' })).status,
      ).toBe(403);
      expect((await rootAgent.get(`/clerkStaffInvitations:get?filterByTk=${id}`)).status).toBe(403);

      const owner =
        (await repo('users').findOne({ filter: { username: 'owner' } })) ||
        (await repo('users').create({ values: { username: 'owner', email: 'owner@salon.test', roles: ['admin'] } }));
      const ownerAgent = await app.agent().login(owner, 'admin');
      expect((await ownerAgent.get('/clerkStaffInvitations:list')).status).toBe(200);
    });

    it('links an accepted invitation to the chosen user, then normal Clerk sign-in works', async () => {
      const rolesBefore = await rolesOf(users.newHire.id);
      const row = await inviteAndRegister(users.newHire, 'hire@salon.test', 'user_newhire');

      // Browser-supplied ids are ignored: only the Clerk session decides.
      const res = await accept(token('user_newhire', 'sess_newhire'), { userId: users.staff.id, invitationId: 999 });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ linked: true, alreadyLinked: false });

      const createdLink = await repo(linksCollection).findOne({ filter: { clerkUserId: 'user_newhire' } });
      expect(createdLink.get('userId')).toBe(users.newHire.id);
      const updated = await invitationRow(row.get('id'));
      expect(updated.get('status')).toBe('accepted');
      expect(updated.get('clerkUserId')).toBe('user_newhire');

      const signedIn = await signIn(token('user_newhire', 'sess_newhire'));
      expect(signedIn.status).toBe(200);
      expect(signedIn.body.data.user.id).toBe(users.newHire.id);
      expect(await rolesOf(users.newHire.id)).toEqual(rolesBefore);
    });

    it('treats repeated acceptance by the same account as a no-op', async () => {
      await inviteAndRegister(users.newHire, 'again@salon.test', 'user_again');
      const tok = token('user_again', 'sess_again');
      expect((await accept(tok)).body.data).toMatchObject({ linked: true, alreadyLinked: false });
      const second = await accept(tok);
      expect(second.status).toBe(200);
      expect(second.body.data).toMatchObject({ linked: true, alreadyLinked: true });
      expect(await repo(linksCollection).count({ filter: { userId: users.newHire.id } })).toBe(1);
    });

    it('refuses registrations that did not come from the invitation', async () => {
      await invite({ email: 'invitee@salon.test', userId: users.newHire.id });

      // Self sign-up with the same, verified address: no server-written invitation reference.
      clerk.addUser('user_self', 'invitee@salon.test');
      const selfSignup = await accept(token('user_self', 'sess_self'), { userId: users.newHire.id });
      expect(selfSignup.status).toBe(403);

      // Reference to the invitation but the wrong secret.
      const row = await repo(invitationsCollection).findOne({ filter: { email: 'invitee@salon.test' } });
      clerk.addUser('user_forged', 'invitee@salon.test', {
        publicMetadata: { nocobaseInvitation: { id: row.get('id'), nonce: 'f'.repeat(48) } },
      });
      expect((await accept(token('user_forged', 'sess_forged'))).status).toBe(403);

      // Correct reference, but Clerk never saw the invitation accepted.
      clerk.addUser('user_pending', 'invitee@salon.test', {
        publicMetadata: { nocobaseInvitation: { id: row.get('id'), nonce: row.get('nonce') } },
      });
      expect((await accept(token('user_pending', 'sess_pending'))).status).toBe(403);

      expect(await repo(linksCollection).count({ filter: { userId: users.newHire.id } })).toBe(0);
      expect((await invitationRow(row.get('id'))).get('status')).toBe('pending');
    });

    it('refuses an account that does not own the invited address or predates the invitation', async () => {
      const row = await inviteAndRegister(users.newHire, 'owner-check@salon.test', 'user_unverified');
      clerk.users.get('user_unverified')!.verifiedEmails = [];
      expect((await accept(token('user_unverified', 'sess_unverified'))).status).toBe(403);

      clerk.users.get('user_unverified')!.verifiedEmails = ['owner-check@salon.test'];
      clerk.users.get('user_unverified')!.createdAt = new Date(row.get('createdAt')).getTime() - 3600_000;
      expect((await accept(token('user_unverified', 'sess_unverified'))).status).toBe(403);
      expect(await repo(linksCollection).count({ filter: { userId: users.newHire.id } })).toBe(0);
    });

    it('refuses revoked and expired invitations', async () => {
      const res = await invite({ email: 'revoke@salon.test', userId: users.newHire.id });
      const id = res.body.data.id;
      const clerkId = (await invitationRow(id)).get('clerkInvitationId');
      const revoked = await (await asRoot()).post(`/clerkStaffInvitations:revoke?filterByTk=${id}`);
      expect(revoked.status).toBe(200);
      expect(revoked.body.data.status).toBe('revoked');
      expect(clerk.revokedInvitations).toContain(clerkId);
      // Even if an account somehow carries the reference, a revoked invitation cannot be accepted.
      const row = await invitationRow(id);
      clerk.addUser('user_late', 'revoke@salon.test', {
        publicMetadata: { nocobaseInvitation: { id, nonce: row.get('nonce') } },
      });
      expect((await accept(token('user_late', 'sess_late'))).status).toBe(410);
      expect((await (await asRoot()).post(`/clerkStaffInvitations:resend?filterByTk=${id}`)).status).toBe(409);

      const expiredRow = await inviteAndRegister(users.newHire2, 'expired@salon.test', 'user_expired');
      await repo(invitationsCollection).update({
        filterByTk: expiredRow.get('id'),
        values: { expiresAt: new Date(Date.now() - 1000) },
      });
      const expired = await accept(token('user_expired', 'sess_expired'));
      expect(expired.status).toBe(410);
      expect(errorOf(expired)).toMatch(/expired/);
      expect(await repo(linksCollection).count()).toBe(0);
    });

    it('deletes invitations in any state, revoking pending ones in Clerk and keeping accepted links', async () => {
      const res = await invite({ email: 'delete@salon.test', userId: users.newHire.id });
      const id = res.body.data.id;
      const clerkId = (await invitationRow(id)).get('clerkInvitationId');
      const deleted = await (await asRoot()).post(`/clerkStaffInvitations:destroy?filterByTk=${id}`);
      expect(deleted.status).toBe(200);
      expect(await invitationRow(id)).toBeNull();
      expect(clerk.revokedInvitations).toContain(clerkId);
      expect((await (await asRoot()).post(`/clerkStaffInvitations:destroy?filterByTk=${id}`)).status).toBe(404);

      const row = await inviteAndRegister(users.newHire2, 'accepted-delete@salon.test', 'user_accepted_delete');
      expect((await accept(token('user_accepted_delete', 'sess_accepted_delete'))).status).toBe(200);
      const acceptedId = row.get('id');
      expect((await (await asRoot()).post(`/clerkStaffInvitations:destroy?filterByTk=${acceptedId}`)).status).toBe(200);
      expect(await invitationRow(acceptedId)).toBeNull();
      expect(await repo(linksCollection).count({ filter: { userId: users.newHire2.id } })).toBe(1);
    });

    it('resend replaces the Clerk invitation and keeps the server-side pairing', async () => {
      const res = await invite({ email: 'resend@salon.test', userId: users.newHire.id });
      const id = res.body.data.id;
      const firstClerkId = (await invitationRow(id)).get('clerkInvitationId');
      const resent = await (await asRoot()).post(`/clerkStaffInvitations:resend?filterByTk=${id}`);
      expect(resent.status).toBe(200);
      const row = await invitationRow(id);
      expect(row.get('clerkInvitationId')).not.toBe(firstClerkId);
      expect(row.get('userId')).toBe(users.newHire.id);
      expect(clerk.invitations.get(firstClerkId)!.status).toBe('revoked');

      clerk.acceptInvitation(row.get('clerkInvitationId'), 'user_resent');
      expect((await accept(token('user_resent', 'sess_resent'))).status).toBe(200);
    });

    it('refuses conflicting links and leaves existing ones untouched', async () => {
      // The invited user got linked to a different Clerk account in the meantime.
      const row = await inviteAndRegister(users.newHire, 'conflict@salon.test', 'user_conflict');
      await link('user_other', users.newHire);
      const res = await accept(token('user_conflict', 'sess_conflict'));
      expect(res.status).toBe(409);
      const existing = await repo(linksCollection).findOne({ filter: { userId: users.newHire.id } });
      expect(existing.get('clerkUserId')).toBe('user_other');
      expect((await invitationRow(row.get('id'))).get('status')).toBe('pending');

      // The registering Clerk account is already linked to someone else.
      await inviteAndRegister(users.newHire2, 'conflict2@salon.test', 'user_conflict2');
      await link('user_conflict2', users.receptionist);
      expect((await accept(token('user_conflict2', 'sess_conflict2'))).status).toBe(409);
      expect(await repo(linksCollection).count({ filter: { userId: users.newHire2.id } })).toBe(0);
    });

    it('refuses acceptance when the invited user lost the staff role, and never adds roles', async () => {
      const row = await inviteAndRegister(users.newHire2, 'role@salon.test', 'user_role');
      await repo('rolesUsers').destroy({ filter: { userId: users.newHire2.id, roleName: 'r_receptionist' } });
      try {
        const res = await accept(token('user_role', 'sess_role'));
        expect(res.status).toBe(403);
        expect(await rolesOf(users.newHire2.id)).not.toContain('r_receptionist');
        expect((await invitationRow(row.get('id'))).get('status')).toBe('pending');
      } finally {
        await repo('rolesUsers').create({ values: { userId: users.newHire2.id, roleName: 'r_receptionist' } });
      }
    });

    it('creates the invitations table on start for installs that predate invitations', async () => {
      const collection = app.db.getCollection(invitationsCollection);
      await app.db.sequelize.getQueryInterface().dropTable(collection.getTableNameWithSchema());
      expect(await collection.existsInDb()).toBe(false);
      await app.emitAsync('beforeStart', app, {});
      expect(await collection.existsInDb()).toBe(true);
      expect((await invite({ email: 'after-upgrade@salon.test', userId: users.newHire.id })).status).toBe(200);
    });

    it('rejects an invalid Clerk token on the public accept endpoint', async () => {
      const forged = mintSessionToken({ privatePem: makeSigningKeys().privatePem, sub: 'user_x', sid: 'sess_x' });
      expect((await accept(forged)).status).toBe(401);
      expect((await app.agent().post('/clerkStaffInvitations:accept').send({})).status).toBe(401);
    });
  });
});
