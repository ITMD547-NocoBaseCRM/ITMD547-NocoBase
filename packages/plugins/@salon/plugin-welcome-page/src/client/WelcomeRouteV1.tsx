import { useAPIClient } from '@nocobase/client';
import React from 'react';
import { WelcomeRoute } from '../client-v2/shared/WelcomeRoute';

export default function WelcomeRouteV1() {
  const api = useAPIClient();
  return <WelcomeRoute api={api as any} />;
}
