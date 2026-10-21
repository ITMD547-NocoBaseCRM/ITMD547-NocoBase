import {
  ClerkFailed,
  ClerkLoaded,
  ClerkLoading,
  ClerkProvider,
  SignIn,
  useAuth,
  useClerk,
  useUser,
} from '@clerk/react';
import { Alert, Button, Space, Spin, Typography } from 'antd';
import React, { useCallback, useEffect, useRef, useState } from 'react';
// @clerk/react imports react-dom and react/jsx-runtime. The NocoBase plugin build only treats a
// package as host-provided when the plugin's own source imports it; without these two lines it
// bundles a second React DOM, which crashes the app ("…__SECRET_INTERNALS…" of undefined).
import 'react-dom';
import 'react/jsx-runtime';
import { useTranslation } from 'react-i18next';
import { namespace, tokenHeader } from '../../constants';
import { shieldClerkScriptsFromAmd } from './amd-shield';
import { safeRedirectTarget } from './redirect';

export type ClerkAuthenticator = {
  name: string;
  title?: string;
  options?: { publishableKey?: string; configured?: boolean };
};

/** The subset of the NocoBase API client (v1 and v2 share it) that the form uses. */
export type ApiClientLike = {
  request: (config: any) => Promise<any>;
  auth: {
    setToken: (token: string | null) => void;
    setAuthenticator: (name: string | null) => void;
    setRole: (role: string | null) => void;
  };
};

/**
 * Set when the Clerk sign-in widget is shown, cleared when an exchange starts. A Clerk session
 * that appears while it is set was created on this page (including the round trip through Google),
 * so the form continues automatically. A Clerk session that already existed (e.g. after a NocoBase
 * sign-out whose Clerk revocation failed) is never used silently: the user has to click Continue.
 */
const INTENT_KEY = 'salon-clerk-signin-intent';
const INTENT_TTL_MS = 15 * 60 * 1000;

const storage = {
  markIntent() {
    try {
      sessionStorage.setItem(INTENT_KEY, String(Date.now()));
    } catch {
      /* storage unavailable: the user just clicks Continue */
    }
  },
  takeIntent() {
    try {
      const value = Number(sessionStorage.getItem(INTENT_KEY));
      sessionStorage.removeItem(INTENT_KEY);
      return Number.isFinite(value) && Date.now() - value < INTENT_TTL_MS;
    } catch {
      return false;
    }
  },
  hasIntent() {
    try {
      const value = Number(sessionStorage.getItem(INTENT_KEY));
      return Number.isFinite(value) && value > 0 && Date.now() - value < INTENT_TTL_MS;
    } catch {
      return false;
    }
  },
};

function useT() {
  const { t } = useTranslation([namespace, 'client'], { nsMode: 'fallback' });
  return t;
}

function errorMessage(error: any, t: (key: string) => string) {
  const serverMessage = error?.response?.data?.errors?.[0]?.message;
  if (serverMessage) return serverMessage;
  if (error?.response?.status >= 500) return t('The server could not complete staff sign-in. Try again.');
  if (error?.message === 'Network Error')
    return t('The server could not be reached. Check your connection and try again.');
  return error?.message || t('Sign-in failed. Try again.');
}

function SignedInGate({ authenticator, apiClient }: { authenticator: ClerkAuthenticator; apiClient: ApiClientLike }) {
  const t = useT();
  const { isSignedIn, getToken } = useAuth();
  const { user } = useUser();
  const clerk = useClerk();
  const [busy, setBusy] = useState<'exchange' | 'signout' | null>(null);
  const [error, setError] = useState('');
  const attempted = useRef(false);

  const exchange = useCallback(async () => {
    storage.takeIntent();
    setError('');
    setBusy('exchange');
    try {
      const token = await getToken({ skipCache: true });
      if (!token) {
        throw new Error(t('Your Clerk session is not active. Please sign in again.'));
      }
      const response = await apiClient.request({
        method: 'post',
        url: 'auth:signIn',
        data: {},
        // The token goes in a header: request bodies are written to the request log, headers are not.
        headers: { 'X-Authenticator': authenticator.name, [tokenHeader]: token },
        skipNotify: true,
        skipAuth: true,
      });
      const nocobaseToken = response?.data?.data?.token;
      if (!nocobaseToken) {
        throw new Error(t('Sign-in failed. Try again.'));
      }
      apiClient.auth.setRole(null);
      apiClient.auth.setAuthenticator(authenticator.name);
      apiClient.auth.setToken(nocobaseToken);
      const params = new URLSearchParams(window.location.search);
      window.location.replace(
        safeRedirectTarget(params.get('redirect'), window.location.pathname, window.location.origin),
      );
    } catch (err) {
      setError(errorMessage(err, t));
      setBusy(null);
    }
  }, [apiClient, authenticator.name, getToken, t]);

  useEffect(() => {
    if (isSignedIn && !attempted.current && storage.hasIntent()) {
      attempted.current = true;
      exchange();
    }
  }, [isSignedIn, exchange]);

  const signOutOfClerk = async () => {
    setBusy('signout');
    try {
      await clerk.signOut();
      setError('');
    } finally {
      setBusy(null);
    }
  };

  if (busy === 'exchange') {
    return (
      <Spin tip={t('Signing you in…')}>
        <div style={{ minHeight: 120 }} />
      </Spin>
    );
  }

  const email = user?.primaryEmailAddress?.emailAddress || user?.username || '';
  return (
    <Space direction="vertical" style={{ display: 'flex' }}>
      {error ? <Alert type="error" showIcon message={error} /> : null}
      <Typography.Text>
        {t('Signed in to Clerk as')} <strong>{email}</strong>
      </Typography.Text>
      <Button type="primary" block onClick={exchange} disabled={!!busy}>
        {t('Continue to the CRM')}
      </Button>
      <Button block onClick={signOutOfClerk} loading={busy === 'signout'} disabled={!!busy}>
        {t('Use a different account')}
      </Button>
    </Space>
  );
}

function SignInWidget() {
  useEffect(() => storage.markIntent(), []);
  // Come back to exactly this page (keeping ?redirect=) after Clerk finishes, including after Google.
  const returnUrl = `${window.location.pathname}${window.location.search}`;
  return (
    <SignIn
      routing="hash"
      withSignUp={false}
      transferable={false}
      forceRedirectUrl={returnUrl}
      appearance={{
        elements: {
          rootBox: { width: '100%' },
          cardBox: { width: '100%', boxShadow: 'none' },
          // Staff accounts are provisioned by administrators; don't advertise self sign-up.
          footerAction: { display: 'none' },
        },
      }}
    />
  );
}

function ClerkGate(props: { authenticator: ClerkAuthenticator; apiClient: ApiClientLike }) {
  const { isSignedIn } = useAuth();
  return isSignedIn ? <SignedInGate {...props} /> : <SignInWidget />;
}

export function ClerkSignInForm({
  authenticator,
  apiClient,
}: {
  authenticator: ClerkAuthenticator;
  apiClient: ApiClientLike;
}) {
  const t = useT();
  const publishableKey = authenticator.options?.publishableKey;
  if (!authenticator.options?.configured || !publishableKey) {
    return (
      <Alert
        type="warning"
        showIcon
        message={t('Staff sign-in is not configured')}
        description={t('Ask an administrator to finish the Clerk setup. Administrators can use the password sign-in.')}
      />
    );
  }
  // Must run before ClerkProvider injects Clerk's scripts (idempotent).
  shieldClerkScriptsFromAmd(publishableKey);
  // Valid ClerkProvider options in @clerk/react 6. They are passed as a spread because the repo's
  // `moduleResolution: node` cannot follow @clerk/shared's `exports` typings and loses these props.
  const redirectOptions: Record<string, unknown> = {
    allowedRedirectOrigins: [window.location.origin],
    afterSignOutUrl: `${window.location.pathname}${window.location.search}`,
  };
  return (
    <ClerkProvider publishableKey={publishableKey} {...redirectOptions}>
      <ClerkLoading>
        <Spin tip={t('Loading sign-in…')}>
          <div style={{ minHeight: 120 }} />
        </Spin>
      </ClerkLoading>
      <ClerkFailed>
        <Alert
          type="error"
          showIcon
          message={t('Clerk could not be loaded')}
          description={t(
            'Check your connection or content blockers and reload the page. Administrators can use the password sign-in.',
          )}
        />
      </ClerkFailed>
      <ClerkLoaded>
        <ClerkGate authenticator={authenticator} apiClient={apiClient} />
      </ClerkLoaded>
    </ClerkProvider>
  );
}

export default ClerkSignInForm;
