/**
 * Post-login redirect policy shared by the v1 (/signin) and v2 (/v/signin) sign-in forms.
 *
 * Only same-origin, path-absolute destinations are accepted. Anything else (absolute URLs,
 * protocol-relative `//host`, backslash tricks, `javascript:`) falls back to the admin home of the
 * client the user signed in from. Destinations that are themselves auth pages fall back too, so a
 * stale `?redirect=/signin` can never bounce the user back into the sign-in form.
 */

const AUTH_PAGES = ['/signin', '/signup', '/forgot-password', '/reset-password'];

/** `/v/signin` -> `/v`, `/nocobase/signin` -> `/nocobase`, `/signin` -> `` */
export function clientBasePath(signInPathname: string): string {
  const match = /^(.*?)\/signin\/?$/.exec(signInPathname || '');
  return match ? match[1] : '';
}

export function defaultHome(signInPathname: string): string {
  return `${clientBasePath(signInPathname)}/admin`;
}

function isAuthPage(pathname: string): boolean {
  const clean = pathname.replace(/\/+$/, '');
  return AUTH_PAGES.some((page) => clean === page || clean.endsWith(page));
}

export function safeRedirectTarget(
  rawRedirect: string | null | undefined,
  signInPathname: string,
  origin: string,
): string {
  const fallback = defaultHome(signInPathname);
  if (!rawRedirect) {
    return fallback;
  }
  const candidate = rawRedirect.trim();
  // Must be path-absolute; reject protocol-relative (`//evil`) and backslash variants (`/\evil`).
  if (!candidate.startsWith('/') || candidate.startsWith('//') || candidate.includes('\\')) {
    return fallback;
  }
  let url: URL;
  try {
    url = new URL(candidate, origin);
  } catch {
    return fallback;
  }
  if (url.origin !== origin || isAuthPage(url.pathname)) {
    return fallback;
  }
  return `${url.pathname}${url.search}${url.hash}`;
}
