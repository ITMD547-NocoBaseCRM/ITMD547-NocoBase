import { ClerkFailed, ClerkLoaded, ClerkLoading, ClerkProvider } from '@clerk/react';
import { Alert, Spin } from 'antd';
import React from 'react';
// @clerk/react imports react-dom and react/jsx-runtime. The NocoBase plugin build only treats a
// package as host-provided when the plugin's own source imports it; without these two lines it
// bundles a second React DOM, which crashes the app ("…__SECRET_INTERNALS…" of undefined).
import 'react-dom';
import 'react/jsx-runtime';
import { useTranslation } from 'react-i18next';
import { namespace, tokenHeader } from '../../constants';
import { shieldClerkScriptsFromAmd } from './amd-shield';

export type ClerkAuthenticator = {
  name: string;
  authType?: string;
  title?: string;
  options?: { publishableKey?: string; configured?: boolean };
};

/** The subset of the NocoBase API client (v1 and v2 share it) that the Clerk pages use. */
export type ApiClientLike = {
  request: (config: any) => Promise<any>;
  auth: {
    setToken: (token: string | null) => void;
    setAuthenticator: (name: string | null) => void;
    setRole: (role: string | null) => void;
  };
};

export function useT() {
  const { t } = useTranslation([namespace, 'client'], { nsMode: 'fallback' });
  return t;
}

export function errorMessage(error: any, t: (key: string) => string) {
  const serverMessage = error?.response?.data?.errors?.[0]?.message;
  if (serverMessage) return serverMessage;
  if (error?.response?.status >= 500) return t('The server could not complete staff sign-in. Try again.');
  if (error?.message === 'Network Error') {
    return t('The server could not be reached. Check your connection and try again.');
  }
  return error?.message || t('Sign-in failed. Try again.');
}

const INTENT_TTL_MS = 15 * 60 * 1000;

/**
 * A short-lived marker that the Clerk flow was started on this page. A Clerk session that appears
 * while it is set (including after a Google or email round trip) continues automatically; a
 * pre-existing Clerk session never does, so a sign-out can't bounce straight back in.
 */
export function createIntent(key: string) {
  return {
    mark() {
      try {
        sessionStorage.setItem(key, String(Date.now()));
      } catch {
        /* storage unavailable: the user just clicks Continue */
      }
    },
    has() {
      try {
        const value = Number(sessionStorage.getItem(key));
        return Number.isFinite(value) && value > 0 && Date.now() - value < INTENT_TTL_MS;
      } catch {
        return false;
      }
    },
    clear() {
      try {
        sessionStorage.removeItem(key);
      } catch {
        /* ignore */
      }
    },
  };
}

/** True when the page was opened from a Clerk invitation link. */
export function hasInvitationTicket(search = window.location.search) {
  const params = new URLSearchParams(search);
  return !!(params.get('__clerk_ticket') || params.get('__clerk_invitation_token'));
}

/**
 * Exchanges the current Clerk session for a NocoBase session through the normal `auth:signIn`
 * lifecycle. The Clerk token travels in a header: request bodies are written to the request log,
 * headers are not.
 */
export async function exchangeForNocoBaseSession(apiClient: ApiClientLike, authenticatorName: string, token: string) {
  const response = await apiClient.request({
    method: 'post',
    url: 'auth:signIn',
    data: {},
    headers: { 'X-Authenticator': authenticatorName, [tokenHeader]: token },
    skipNotify: true,
    skipAuth: true,
  });
  const nocobaseToken = response?.data?.data?.token;
  if (!nocobaseToken) {
    throw new Error('Sign-in failed. Try again.');
  }
  apiClient.auth.setRole(null);
  apiClient.auth.setAuthenticator(authenticatorName);
  apiClient.auth.setToken(nocobaseToken);
}

/** ClerkProvider with this plugin's loading/failure states and the RequireJS shield. */
export function ClerkShell({ publishableKey, children }: { publishableKey: string; children: React.ReactNode }) {
  const t = useT();
  // Must run before ClerkProvider injects Clerk's scripts (idempotent).
  shieldClerkScriptsFromAmd(publishableKey);
  // Valid ClerkProvider options in @clerk/react 6. They are passed as a spread because the repo's
  // `moduleResolution: node` cannot follow @clerk/shared's `exports` typings and loses these props.
  const redirectOptions: Record<string, unknown> = {
    allowedRedirectOrigins: [window.location.origin],
    afterSignOutUrl: `${window.location.pathname}${window.location.search}`,
  };
  return (
    <ClerkProvider publishableKey={publishableKey} {...redirectOptions}>
      <ClerkLoading>
        <Spin tip={t('Loading sign-in…')}>
          <div style={{ minHeight: 120 }} />
        </Spin>
      </ClerkLoading>
      <ClerkFailed>
        <Alert
          type="error"
          showIcon
          message={t('Clerk could not be loaded')}
          description={t(
            'Check your connection or content blockers and reload the page. Administrators can use the password sign-in.',
          )}
        />
      </ClerkFailed>
      <ClerkLoaded>{children}</ClerkLoaded>
    </ClerkProvider>
  );
}

/** Shared look for Clerk widgets embedded in NocoBase pages. */
export const clerkAppearance = {
  elements: {
    rootBox: { width: '100%' },
    cardBox: { width: '100%', boxShadow: 'none' },
  },
};
