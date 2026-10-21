import { describe, expect, it } from 'vitest';
import { safeRedirectTarget } from '../../client-v2/shared/redirect';
import { readClerkConfig } from '../config';
import type { ClerkConfig } from '../config';
import { ClerkAuthError } from '../errors';
import { issuerFromPublishableKey } from '../publishable-key';
import { verifyClerkSessionToken } from '../token-verifier';
import { clerkEnv, ISSUER, makeSigningKeys, mintSessionToken, ORIGIN, PUBLISHABLE_KEY } from './helpers';

const keys = makeSigningKeys();
const otherKeys = makeSigningKeys();

function config(overrides: Record<string, string> = {}): ClerkConfig {
  const result = readClerkConfig({ ...clerkEnv(keys.publicPem), ...overrides });
  if (result.ok === false) throw new Error(result.problems.join('; '));
  return result.config;
}

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as ClerkAuthError;
  }
  throw new Error('expected the token to be rejected');
}

describe('verifyClerkSessionToken', () => {
  it('accepts a valid session token and returns only the Clerk user and session ids', async () => {
    const token = mintSessionToken({ privatePem: keys.privatePem });
    await expect(verifyClerkSessionToken(token, config())).resolves.toEqual({
      clerkUserId: 'user_staff1',
      sessionId: 'sess_staff1',
    });
  });

  it.each([
    ['missing token', () => undefined],
    ['garbage', () => 'not-a-jwt'],
    ['wrong signing key', () => mintSessionToken({ privatePem: otherKeys.privatePem })],
    ['expired', () => mintSessionToken({ privatePem: keys.privatePem, expiresInSeconds: -120 })],
    ['wrong issuer', () => mintSessionToken({ privatePem: keys.privatePem, iss: 'https://evil.clerk.accounts.dev' })],
    ['wrong authorized party', () => mintSessionToken({ privatePem: keys.privatePem, azp: 'https://evil.example' })],
    ['missing authorized party', () => mintSessionToken({ privatePem: keys.privatePem, azp: null })],
    ['no session id (custom JWT template)', () => mintSessionToken({ privatePem: keys.privatePem, sid: null })],
    ['pending session', () => mintSessionToken({ privatePem: keys.privatePem, extra: { sts: 'pending' } })],
    ['impersonation', () => mintSessionToken({ privatePem: keys.privatePem, extra: { act: { sub: 'user_admin' } } })],
    ['subject is not a user id', () => mintSessionToken({ privatePem: keys.privatePem, sub: 'org_123' })],
    ['oversized', () => 'a'.repeat(9000)],
  ])('rejects: %s', async (_name, makeToken) => {
    const error = await rejection(verifyClerkSessionToken(makeToken(), config()));
    expect(error).toBeInstanceOf(ClerkAuthError);
    expect(error.status).toBe(401);
    expect(error.code).toBe('CLERK_TOKEN_INVALID');
    // The browser-facing message never echoes token contents.
    expect(error.message).not.toMatch(/eyJ/);
  });

  it('requires a matching aud when an audience is configured, even if the token has none', async () => {
    const strict = config({ CLERK_AUDIENCE: 'salon-crm' });
    await expect(
      rejection(verifyClerkSessionToken(mintSessionToken({ privatePem: keys.privatePem }), strict)),
    ).resolves.toBeInstanceOf(ClerkAuthError);
    await expect(
      rejection(verifyClerkSessionToken(mintSessionToken({ privatePem: keys.privatePem, aud: 'other-app' }), strict)),
    ).resolves.toBeInstanceOf(ClerkAuthError);
    await expect(
      verifyClerkSessionToken(mintSessionToken({ privatePem: keys.privatePem, aud: 'salon-crm' }), strict),
    ).resolves.toMatchObject({
      clerkUserId: 'user_staff1',
    });
  });
});

describe('readClerkConfig', () => {
  it('derives the issuer from the publishable key', () => {
    expect(issuerFromPublishableKey(PUBLISHABLE_KEY)).toBe(ISSUER);
    expect(config().issuer).toBe(ISSUER);
  });

  it('fails closed when required settings are missing', () => {
    const result = readClerkConfig({});
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.problems.join(' ')).toMatch(
      /CLERK_PUBLISHABLE_KEY.*CLERK_SECRET_KEY.*CLERK_AUTHORIZED_PARTIES/s,
    );
  });

  it('rejects a non-origin authorized party', () => {
    const result = readClerkConfig({
      ...clerkEnv(keys.publicPem),
      CLERK_AUTHORIZED_PARTIES: 'https://crm.example.com/path',
    });
    expect(result.ok).toBe(false);
  });

  it('sends invitations back to the CRM invitation page by default', () => {
    expect(config().inviteRedirectUrl).toBe(`${ORIGIN}/staff-invite`);
    expect(config({ CLERK_INVITE_REDIRECT_URL: `${ORIGIN}/v/staff-invite` }).inviteRedirectUrl).toBe(
      `${ORIGIN}/v/staff-invite`,
    );
    expect(config().invitationTtlDays).toBe(7);
  });

  it('refuses an invitation redirect outside the authorized origins', () => {
    const result = readClerkConfig({
      ...clerkEnv(keys.publicPem),
      CLERK_INVITE_REDIRECT_URL: 'https://evil.example/x',
    });
    expect(result.ok).toBe(false);
    const ttl = readClerkConfig({ ...clerkEnv(keys.publicPem), CLERK_INVITATION_EXPIRES_DAYS: '90' });
    expect(ttl.ok).toBe(false);
  });

  it('defaults to the salon staff roles and never allows root', () => {
    expect(config().allowedRoles).toEqual(['admin', 'r_staff', 'r_receptionist']);
    expect(config({ CLERK_ALLOWED_ROLES: 'root,r_staff' }).allowedRoles).toEqual(['r_staff']);
  });
});

describe('safeRedirectTarget', () => {
  it.each([
    [null, '/signin', '/admin'],
    ['/admin/abc?x=1', '/signin', '/admin/abc?x=1'],
    ['/v/admin/abc', '/v/signin', '/v/admin/abc'],
    [null, '/v/signin', '/v/admin'],
    ['https://evil.example/admin', '/signin', '/admin'],
    ['//evil.example/admin', '/signin', '/admin'],
    ['/\\evil.example', '/signin', '/admin'],
    ['javascript:alert(1)', '/signin', '/admin'],
    ['/signin?redirect=/admin', '/signin', '/admin'],
    ['/v/signin', '/v/signin', '/v/admin'],
  ])('%s from %s -> %s', (redirect, signInPath, expected) => {
    expect(safeRedirectTarget(redirect, signInPath, ORIGIN)).toBe(expected);
  });
});
