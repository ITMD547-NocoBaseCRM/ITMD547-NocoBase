// Review link tokens. Pure helpers (only node:crypto), unit-tested in __tests__/core.test.ts.
//
// - 32 random bytes from the OS CSPRNG = 256 bits, encoded base64url (43 characters, URL-safe).
// - Only an HMAC-SHA256 of the token is stored. The HMAC key is the app's APP_KEY, so a copy of the
//   database alone is not enough to check guesses offline. Without APP_KEY a plain SHA-256 is used.
// - The plaintext token exists only in memory while one email is being built, and in that email.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/** Cheap shape check before any database lookup; rejects junk without touching the database. */
export function isWellFormedToken(token: unknown): token is string {
  return typeof token === 'string' && TOKEN_PATTERN.test(token);
}

export function hashToken(token: string, secret?: string): string {
  if (secret) return createHmac('sha256', secret).update(token, 'utf8').digest('hex');
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Constant-time comparison of two hex hashes. */
export function sameHash(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** Builds the link sent to the customer. The token goes in the fragment: never sent to any server. */
export function reviewUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/review#t=${token}`;
}
