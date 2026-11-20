/** Router-relative paths. The modern client's router adds its `/v` basename automatically. */
export const SIGN_IN_PATH = '/signin';
/** Same target NocoBase's own root redirect uses; AdminLayout then opens the user's first page. */
export const DASHBOARD_PATH = '/admin';

export type SessionStatus = 'anonymous' | 'authenticated';

/** The subset of the NocoBase API client (identical in v1 and v2) used here. */
export type SessionApi = {
  auth?: { getToken?: () => string | null | undefined; token?: string | null };
  request: (config: Record<string, any>) => Promise<any>;
};

/**
 * Decides whether the visitor has a live NocoBase session.
 *
 * A stored token alone is not trusted: it may be expired, revoked or blocked. It is only a hint
 * that a server check is worth making. `auth:check` goes through NocoBase's normal auth middleware
 * (whatever authenticator issued the session, including token renewal) and returns the user only
 * if the session is valid. `skipAuth` stops a 401 from triggering NocoBase's global "go to sign-in"
 * redirect, and `skipNotify` keeps it silent: on the welcome page an expired session just means
 * "show the welcome page".
 */
export async function resolveSession(api: SessionApi): Promise<SessionStatus> {
  const token = api.auth?.getToken?.() ?? api.auth?.token;
  if (!token) {
    return 'anonymous';
  }
  try {
    const response = await api.request({ url: 'auth:check', method: 'get', skipAuth: true, skipNotify: true });
    return response?.data?.data?.id ? 'authenticated' : 'anonymous';
  } catch {
    return 'anonymous';
  }
}
