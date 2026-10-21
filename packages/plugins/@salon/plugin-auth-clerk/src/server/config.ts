import { issuerFromPublishableKey } from './publishable-key';

/**
 * All Clerk configuration comes from the server environment. Nothing secret is stored in the
 * database or sent to the browser; the publishable key is the only value the client receives, via
 * the authenticator's public options (`authenticators:publicList`).
 */
export type ClerkConfig = {
  publishableKey: string;
  secretKey: string;
  /** PEM public key for networkless verification. Optional: without it the JWKS is fetched with the secret key. */
  jwtKey?: string;
  issuer: string;
  /** Origins allowed in the token's `azp` claim, e.g. `https://crm.example.com`. */
  authorizedParties: string[];
  /** Only enforced when set; then the token must carry a matching `aud`. */
  audience: string[];
  /** NocoBase roles that count as staff. A linked user needs at least one of them. */
  allowedRoles: string[];
  /** How often an issued NocoBase session re-confirms that its Clerk session is still active. */
  sessionRecheckMs: number;
  clockSkewMs: number;
};

export type ConfigResult = { ok: true; config: ClerkConfig } | { ok: false; problems: string[] };

export const DEFAULT_ALLOWED_ROLES = ['admin', 'r_staff', 'r_receptionist'];

/** `root` is the bootstrap superuser and always stays on the password fallback. */
const NEVER_ALLOWED_ROLES = ['root'];

const list = (value: string | undefined) =>
  (value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

const normalizeOrigin = (value: string) => value.replace(/\/+$/, '');

export function readClerkConfig(env: NodeJS.ProcessEnv = process.env): ConfigResult {
  const problems: string[] = [];
  const publishableKey = (env.CLERK_PUBLISHABLE_KEY || '').trim();
  const secretKey = (env.CLERK_SECRET_KEY || '').trim();
  const jwtKey = (env.CLERK_JWT_KEY || '').replace(/\\n/g, '\n').trim() || undefined;

  if (!publishableKey) problems.push('CLERK_PUBLISHABLE_KEY is not set');
  if (!secretKey) problems.push('CLERK_SECRET_KEY is not set');
  if (secretKey && !/^sk_(test|live)_/.test(secretKey)) problems.push('CLERK_SECRET_KEY is not a Clerk secret key');

  const issuer = normalizeOrigin((env.CLERK_ISSUER || '').trim()) || issuerFromPublishableKey(publishableKey);
  if (!issuer) problems.push('CLERK_ISSUER is not set and could not be derived from CLERK_PUBLISHABLE_KEY');

  const authorizedParties = list(env.CLERK_AUTHORIZED_PARTIES).map(normalizeOrigin);
  if (!authorizedParties.length) problems.push('CLERK_AUTHORIZED_PARTIES is not set');
  for (const party of authorizedParties) {
    if (!/^https?:\/\/[^/\s]+$/.test(party))
      problems.push(`CLERK_AUTHORIZED_PARTIES entry "${party}" is not an origin`);
  }

  const requestedRoles = env.CLERK_ALLOWED_ROLES ? list(env.CLERK_ALLOWED_ROLES) : DEFAULT_ALLOWED_ROLES;
  const allowedRoles = requestedRoles.filter((role) => !NEVER_ALLOWED_ROLES.includes(role));
  if (!allowedRoles.length) problems.push('CLERK_ALLOWED_ROLES does not contain any usable role');

  const recheckSeconds = Number(env.CLERK_SESSION_RECHECK_SECONDS ?? 300);
  if (!Number.isFinite(recheckSeconds) || recheckSeconds < 30) {
    problems.push('CLERK_SESSION_RECHECK_SECONDS must be a number >= 30');
  }

  if (problems.length) {
    return { ok: false, problems };
  }
  return {
    ok: true,
    config: {
      publishableKey,
      secretKey,
      jwtKey,
      issuer,
      authorizedParties,
      audience: list(env.CLERK_AUDIENCE),
      allowedRoles,
      sessionRecheckMs: recheckSeconds * 1000,
      clockSkewMs: 5000,
    },
  };
}
