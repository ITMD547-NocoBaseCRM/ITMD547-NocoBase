import type { MockServer } from '@nocobase/test';
import { createRequire } from 'module';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bindingsCollection, linksCollection, namespace } from '../../constants';
import type { ClerkApi, ClerkUserSummary } from '../clerk-api';
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

class FakeClerk implements ClerkApi {
  sessions = new Map<string, string>();
  users = new Map<string, ClerkUserSummary>();
  revoked: string[] = [];
  unreachable = false;

  addUser(id: string, primaryEmail: string) {
    this.users.set(id, { id, primaryEmail, name: '', banned: false, locked: false });
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
});
