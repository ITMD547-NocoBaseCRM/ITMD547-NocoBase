import { useApp } from '@nocobase/client-v2';
import React from 'react';
import { AcceptInvitationPage } from '../shared/AcceptInvitationPage';

export default function AcceptInvitationRouteV2() {
  const app = useApp();
  return <AcceptInvitationPage apiClient={app.apiClient as any} />;
}
