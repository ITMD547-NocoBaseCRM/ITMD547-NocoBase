import { useAPIClient } from '@nocobase/client';
import React from 'react';
import { AcceptInvitationPage } from '../client-v2/shared/AcceptInvitationPage';

export default function AcceptInvitationRoute() {
  const api = useAPIClient();
  return <AcceptInvitationPage apiClient={api as any} />;
}
