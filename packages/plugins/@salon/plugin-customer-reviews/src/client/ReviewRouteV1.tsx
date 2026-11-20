import { useAPIClient } from '@nocobase/client';
import React from 'react';
import { ReviewPage } from '../client-v2/shared/ReviewPage';

export default function ReviewRouteV1() {
  const api: any = useAPIClient();
  return <ReviewPage apiBase={api?.axios?.defaults?.baseURL || (window as any).__nocobase_api_base_url__ || '/api/'} />;
}
