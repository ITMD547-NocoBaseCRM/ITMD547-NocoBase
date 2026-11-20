import { generateKeyPairSync } from 'crypto';
import jwt from 'jsonwebtoken';

/** A throwaway RSA key pair standing in for a Clerk instance's signing key. */
export function makeSigningKeys() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

export const FRONTEND_API = 'clerk.salon-test.example';
export const ISSUER = `https://${FRONTEND_API}`;
export const ORIGIN = 'http://localhost:13000';
export const PUBLISHABLE_KEY = `pk_test_${Buffer.from(`${FRONTEND_API}$`).toString('base64')}`;

export type TokenOptions = {
  sub?: string;
  sid?: string | null;
  iss?: string;
  azp?: string | null;
  aud?: string | string[];
  expiresInSeconds?: number;
  extra?: Record<string, any>;
  privatePem: string;
};

/** Mints a token shaped like a Clerk v2 session token. */
export function mintSessionToken(options: TokenOptions) {
  const now = Math.floor(Date.now() / 1000);
  const payload: Record<string, any> = {
    sub: options.sub ?? 'user_staff1',
    iss: options.iss ?? ISSUER,
    iat: now - 1,
    nbf: now - 1,
    exp: now + (options.expiresInSeconds ?? 60),
    v: 2,
    ...options.extra,
  };
  if (options.sid !== null) payload.sid = options.sid ?? 'sess_staff1';
  if (options.azp !== null) payload.azp = options.azp ?? ORIGIN;
  if (options.aud) payload.aud = options.aud;
  return jwt.sign(payload, options.privatePem, { algorithm: 'RS256', keyid: 'ins_test_key' });
}

export function clerkEnv(publicPem: string): Record<string, string> {
  return {
    CLERK_PUBLISHABLE_KEY: PUBLISHABLE_KEY,
    CLERK_SECRET_KEY: 'sk_test_placeholder_not_a_real_key',
    CLERK_JWT_KEY: publicPem,
    CLERK_AUTHORIZED_PARTIES: ORIGIN,
    CLERK_SESSION_RECHECK_SECONDS: '60',
  };
}
