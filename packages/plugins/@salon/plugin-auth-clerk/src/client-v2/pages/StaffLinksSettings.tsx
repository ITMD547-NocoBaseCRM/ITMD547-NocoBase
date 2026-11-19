import { useApp } from '@nocobase/client-v2';
import React from 'react';
import { StaffLinksPage } from '../shared/StaffLinksPage';

export default function StaffLinksSettings() {
  const app = useApp();
  return <StaffLinksPage api={app.apiClient as any} />;
}
