import { useApp } from '@nocobase/client-v2';
import React from 'react';
import { WelcomeRoute } from '../shared/WelcomeRoute';

export default function WelcomeRouteV2() {
  const app = useApp();
  return <WelcomeRoute api={app.apiClient as any} />;
}
