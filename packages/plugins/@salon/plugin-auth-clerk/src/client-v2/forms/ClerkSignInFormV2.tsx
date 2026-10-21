import { useApp } from '@nocobase/client-v2';
import React from 'react';
import { ClerkSignInForm } from '../shared/ClerkSignInForm';
import type { ClerkAuthenticator } from '../shared/ClerkSignInForm';

export default function ClerkSignInFormV2({ authenticator }: { authenticator: ClerkAuthenticator }) {
  const app = useApp();
  return <ClerkSignInForm authenticator={authenticator} apiClient={app.apiClient as any} />;
}
