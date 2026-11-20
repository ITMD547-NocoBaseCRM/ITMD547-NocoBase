/**
 * A Clerk publishable key is `pk_(test|live)_` + base64("<frontend-api-host>$").
 * The session-token issuer is `https://<frontend-api-host>`, so the server can derive the expected
 * issuer from the same publishable key the browser uses instead of trusting anything in the token.
 */
export function frontendApiFromPublishableKey(publishableKey: string | undefined): string | null {
  const match = /^pk_(test|live)_([A-Za-z0-9+/=_-]+)$/.exec((publishableKey || '').trim());
  if (!match) {
    return null;
  }
  const decoded = Buffer.from(match[2], 'base64').toString('utf8');
  if (!decoded.endsWith('$')) {
    return null;
  }
  const host = decoded.slice(0, -1);
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host) ? host : null;
}

export function issuerFromPublishableKey(publishableKey: string | undefined): string | null {
  const host = frontendApiFromPublishableKey(publishableKey);
  return host ? `https://${host}` : null;
}
