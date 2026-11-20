import { SignIn, useAuth, useClerk, useUser } from '@clerk/react';
import { Alert, Button, Space, Spin, Typography } from 'antd';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { invitePagePath } from '../../constants';
import {
  clerkAppearance,
  ClerkShell,
  createIntent,
  errorMessage,
  exchangeForNocoBaseSession,
  hasInvitationTicket,
  useT,
} from './clerk-common';
import type { ApiClientLike, ClerkAuthenticator } from './clerk-common';
import { clientBasePath, safeRedirectTarget } from './redirect';

export type { ApiClientLike, ClerkAuthenticator } from './clerk-common';

/**
 * Set when the Clerk sign-in widget is shown. A Clerk session that appears while it is set was
 * created on this page (including the round trip through Google), so the form continues
 * automatically. A Clerk session that already existed (e.g. after a NocoBase sign-out whose Clerk
 * revocation failed) is never used silently: the user has to click Continue.
 */
const intent = createIntent('salon-clerk-signin-intent');

function SignedInGate({ authenticator, apiClient }: { authenticator: ClerkAuthenticator; apiClient: ApiClientLike }) {
  const t = useT();
  const { isSignedIn, getToken } = useAuth();
  const { user } = useUser();
  const clerk = useClerk();
  const [busy, setBusy] = useState<'exchange' | 'signout' | null>(null);
  const [error, setError] = useState('');
  const attempted = useRef(false);

  const exchange = useCallback(async () => {
    intent.clear();
    setError('');
    setBusy('exchange');
    try {
      const token = await getToken({ skipCache: true });
      if (!token) {
        throw new Error(t('Your Clerk session is not active. Please sign in again.'));
      }
      await exchangeForNocoBaseSession(apiClient, authenticator.name, token);
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
    if (isSignedIn && !attempted.current && intent.has()) {
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
  useEffect(() => intent.mark(), []);
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
          ...clerkAppearance.elements,
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
  const invited = hasInvitationTicket();
  useEffect(() => {
    // An invitation link landed on the sign-in page: registration happens on the invitation page of
    // the same client (/staff-invite or /v/staff-invite). Clerk's ticket travels along unchanged.
    if (invited) {
      const base = clientBasePath(window.location.pathname);
      window.location.replace(`${base}${invitePagePath}${window.location.search}${window.location.hash}`);
    }
  }, [invited]);
  if (invited) {
    return (
      <Spin tip={t('Opening your invitation…')}>
        <div style={{ minHeight: 120 }} />
      </Spin>
    );
  }

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
  return (
    <ClerkShell publishableKey={publishableKey}>
      <ClerkGate authenticator={authenticator} apiClient={apiClient} />
    </ClerkShell>
  );
}

export default ClerkSignInForm;
