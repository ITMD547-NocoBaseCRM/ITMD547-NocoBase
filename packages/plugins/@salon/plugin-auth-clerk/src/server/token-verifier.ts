import { verifyToken } from '@clerk/backend';
import { ClerkErrorCode } from '../constants';
import type { ClerkConfig } from './config';
import { ClerkAuthError } from './errors';

export type VerifiedClerkSession = {
  clerkUserId: string;
  sessionId: string;
};

const CLERK_USER_ID = /^user_[A-Za-z0-9]+$/;
const CLERK_SESSION_ID = /^sess_[A-Za-z0-9]+$/;
// Session tokens are tiny; anything bigger is not one and is rejected before any crypto runs.
const MAX_TOKEN_LENGTH = 8192;

const invalid = (reason: string) =>
  new ClerkAuthError(
    401,
    ClerkErrorCode.TOKEN_INVALID,
    'Your Clerk sign-in could not be verified. Please sign in again.',
    reason,
  );

/**
 * Verifies a Clerk *session* token with `@clerk/backend`'s `verifyToken`:
 * signature (JWKS or PEM), `exp`/`nbf`/`iat` with clock skew, `iss`, `azp`, and `aud`.
 *
 * `verifyToken` silently skips the issuer/azp checks when they are not supplied and only checks
 * `aud` when the token carries one, so this wrapper always supplies them (config guarantees they
 * exist) and adds the stricter checks itself. Error details go to the server log via `reason`; the
 * browser only sees a generic message.
 */
export async function verifyClerkSessionToken(
  token: string | undefined,
  config: ClerkConfig,
): Promise<VerifiedClerkSession> {
  if (!token || typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH) {
    throw invalid('missing or oversized token');
  }

  // The package's exported `verifyToken` uses the legacy contract: it resolves to the claims and
  // throws on any verification failure. The `{ data, errors }` shape is handled too in case that changes.
  let claims: Record<string, any>;
  try {
    const result: any = await verifyToken(token, {
      secretKey: config.secretKey,
      jwtKey: config.jwtKey,
      issuer: config.issuer,
      authorizedParties: config.authorizedParties,
      audience: config.audience.length ? config.audience : undefined,
      clockSkewInMs: config.clockSkewMs,
    });
    if (result?.errors) throw result.errors[0] ?? new Error('verification failed');
    claims = result?.data ?? result;
  } catch (error: any) {
    throw invalid(error?.message || 'verification failed');
  }
  if (!claims || typeof claims !== 'object') {
    throw invalid('no claims');
  }

  // Defence in depth: these are already enforced above, but the library treats missing values as "skip".
  if (claims.iss !== config.issuer) throw invalid('issuer mismatch');
  if (!claims.azp || !config.authorizedParties.includes(claims.azp)) throw invalid('authorized party mismatch');
  if (config.audience.length) {
    const aud = [claims.aud].flat().filter(Boolean) as string[];
    if (!aud.some((value) => config.audience.includes(value))) throw invalid('audience mismatch');
  }

  const clerkUserId = claims.sub;
  const sessionId = (claims as any).sid;
  if (typeof clerkUserId !== 'string' || !CLERK_USER_ID.test(clerkUserId))
    throw invalid('subject is not a Clerk user id');
  // Only real session tokens carry `sid`; custom JWT templates and machine tokens are refused.
  if (typeof sessionId !== 'string' || !CLERK_SESSION_ID.test(sessionId)) throw invalid('not a session token');
  // `sts` (v2 session tokens): a "pending" session still has unfinished tasks and is not signed in yet.
  const status = (claims as any).sts;
  if (status !== undefined && status !== 'active') throw invalid(`session status ${status}`);
  // Impersonation ("act" claim) is refused: a staff CRM session must belong to the staff member.
  if ((claims as any).act) throw invalid('impersonation session');

  return { clerkUserId, sessionId };
}
