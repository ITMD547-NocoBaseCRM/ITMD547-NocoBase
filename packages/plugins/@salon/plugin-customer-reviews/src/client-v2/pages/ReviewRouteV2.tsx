import { useApp } from '@nocobase/client-v2';
import React from 'react';
import { ReviewPage } from '../shared/ReviewPage';

export default function ReviewRouteV2() {
  const app: any = useApp();
  return <ReviewPage apiBase={app?.apiClient?.axios?.defaults?.baseURL || (window as any).__nocobase_api_base_url__ || '/api/'} />;
}
