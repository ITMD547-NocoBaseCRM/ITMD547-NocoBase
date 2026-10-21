import { useAPIClient } from '@nocobase/client';
import React from 'react';
import { StaffLinksPage } from '../client-v2/shared/StaffLinksPage';

export default function StaffLinksSettings() {
  const api = useAPIClient();
  return <StaffLinksPage api={api as any} />;
}
