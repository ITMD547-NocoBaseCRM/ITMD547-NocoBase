import { SignUp, useAuth, useClerk, useUser } from '@clerk/react';
import { Alert, Button, Card, Space, Spin, Typography } from 'antd';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { authType, invitationsCollection, invitePagePath, tokenHeader } from '../../constants';
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

/**
 * Public page Clerk invitation emails link to (`/staff-invite`, or `/v/staff-invite` in the modern
 * client). Clerk's <SignUp/> consumes the invitation ticket from the URL, pre-fills the invited
 * address and lets the person choose a password. Then the server links the new Clerk account to the
 * NocoBase user chosen by the administrator, and the normal Clerk sign-in exchange runs.
 *
 * Nothing on this page decides who is linked to whom: the server only trusts the verified Clerk
 * session and what it reads back from Clerk's Backend API.
 */
const intent = createIntent('salon-clerk-invite-intent');

/** `/v/staff-invite` -> `/v`, `/staff-invite` -> `` */
const clientBase = () => window.location.pathname.replace(new RegExp(`${invitePagePath}/?$`), '');

function AcceptGate({ authenticator, apiClient }: { authenticator: ClerkAuthenticator; apiClient: ApiClientLike }) {
  const t = useT();
  const { getToken } = useAuth();
  const { user } = useUser();
  const clerk = useClerk();
  const [busy, setBusy] = useState<'accept' | 'signout' | null>(null);
  const [error, setError] = useState('');
  const attempted = useRef(false);

  const accept = useCallback(async () => {
    intent.clear();
    setError('');
    setBusy('accept');
    try {
      const token = await getToken({ skipCache: true });
      if (!token) throw new Error(t('Your Clerk session is not active. Please sign in again.'));
      await apiClient.request({
        method: 'post',
        url: `${invitationsCollection}:accept`,
        data: {},
        headers: { [tokenHeader]: token },
        skipNotify: true,
        skipAuth: true,
      });
      // Clerk session tokens live ~60s: take a fresh one for the sign-in exchange.
      const signInToken = await getToken({ skipCache: true });
      await exchangeForNocoBaseSession(apiClient, authenticator.name, signInToken || token);
      window.location.replace(`${clientBase()}/admin`);
    } catch (err) {
      setError(errorMessage(err, t));
      setBusy(null);
    }
  }, [apiClient, authenticator.name, getToken, t]);

  useEffect(() => {
    if (!attempted.current && intent.has()) {
      attempted.current = true;
      accept();
    }
  }, [accept]);

  const signOutOfClerk = async () => {
    setBusy('signout');
    try {
      await clerk.signOut();
      setError('');
    } finally {
      setBusy(null);
    }
  };

  if (busy === 'accept') {
    return (
      <Spin tip={t('Setting up your staff access…')}>
        <div style={{ minHeight: 120 }} />
      </Spin>
    );
  }
  const email = user?.primaryEmailAddress?.emailAddress || '';
  return (
    <Space direction="vertical" style={{ display: 'flex' }}>
      {error ? <Alert type="error" showIcon message={error} /> : null}
      <Typography.Text>
        {t('Signed in to Clerk as')} <strong>{email}</strong>
      </Typography.Text>
      <Button type="primary" block onClick={accept} disabled={!!busy}>
        {t('Accept invitation')}
      </Button>
      <Button block onClick={signOutOfClerk} loading={busy === 'signout'} disabled={!!busy}>
        {t('Use a different account')}
      </Button>
    </Space>
  );
}

function RegistrationWidget() {
  useEffect(() => intent.mark(), []);
  // After registration Clerk returns here without the ticket; the marker then continues the flow.
  return (
    <SignUp
      routing="hash"
      forceRedirectUrl={window.location.pathname}
      signInUrl={`${clientBase()}/signin`}
      appearance={clerkAppearance}
    />
  );
}

function InviteGate(props: { authenticator: ClerkAuthenticator; apiClient: ApiClientLike }) {
  const t = useT();
  const { isSignedIn } = useAuth();
  if (isSignedIn) return <AcceptGate {...props} />;
  if (hasInvitationTicket()) return <RegistrationWidget />;
  return (
    <Space direction="vertical" style={{ display: 'flex' }}>
      <Alert
        type="info"
        showIcon
        message={t('Open this page from your invitation email')}
        description={t(
          'Staff accounts are created by invitation only. Use the link in the email you received, or ask an administrator to resend it.',
        )}
      />
      <Button href={`${clientBase()}/signin`} block>
        {t('Go to staff sign-in')}
      </Button>
    </Space>
  );
}

export function AcceptInvitationPage({ apiClient }: { apiClient: ApiClientLike }) {
  const t = useT();
  const [authenticator, setAuthenticator] = useState<ClerkAuthenticator | null | undefined>(undefined);

  useEffect(() => {
    document.title = t('Accept staff invitation');
    apiClient
      .request({ url: 'authenticators:publicList', skipNotify: true, skipAuth: true })
      .then((res) => {
        const list: ClerkAuthenticator[] = res?.data?.data || [];
        setAuthenticator(list.find((item) => item.authType === authType) || null);
      })
      .catch(() => setAuthenticator(null));
  }, [apiClient, t]);

  let body: React.ReactNode;
  if (authenticator === undefined) {
    body = (
      <Spin tip={t('Loading…')}>
        <div style={{ minHeight: 120 }} />
      </Spin>
    );
  } else if (!authenticator || !authenticator.options?.configured || !authenticator.options?.publishableKey) {
    body = (
      <Alert
        type="warning"
        showIcon
        message={t('Staff sign-in is not available')}
        description={t('Ask an administrator to enable staff sign-in, then open your invitation link again.')}
      />
    );
  } else {
    body = (
      <ClerkShell publishableKey={authenticator.options.publishableKey}>
        <InviteGate authenticator={authenticator} apiClient={apiClient} />
      </ClerkShell>
    );
  }

  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        padding: 16,
        background: 'var(--colorBgLayout, #f5f5f5)',
      }}
    >
      <Card style={{ width: '100%', maxWidth: 460 }}>
        <Typography.Title level={3} style={{ marginTop: 0 }}>
          {t('Accept your staff invitation')}
        </Typography.Title>
        <Typography.Paragraph type="secondary">
          {t('Create your sign-in for the CRM. Your access and permissions are set by an administrator.')}
        </Typography.Paragraph>
        {body}
      </Card>
    </main>
  );
}

export default AcceptInvitationPage;
