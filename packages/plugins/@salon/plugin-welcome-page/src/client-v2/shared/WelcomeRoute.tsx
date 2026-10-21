import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { brandName } from '../../constants';
import { DASHBOARD_PATH, resolveSession } from './session';
import type { SessionApi } from './session';
import { SessionCheck, WelcomePage } from './WelcomePage';

/**
 * Element for the root route (`/`).
 *
 * - No stored session token: the welcome page renders immediately (no request is made).
 * - A stored token: the server is asked (`auth:check`). A valid session goes to the CRM dashboard
 *   with `replace`, so Back does not return to `/`. An invalid or expired one shows the welcome page.
 *
 * No loops: `/` only ever redirects to the dashboard, and only after the server confirmed the
 * session. Sign-in and dashboard pages never redirect to `/`.
 */
export function WelcomeRoute({ api }: { api: SessionApi }) {
  const navigate = useNavigate();
  const hasToken = !!(api.auth?.getToken?.() ?? api.auth?.token);
  const [checking, setChecking] = useState(hasToken);

  useEffect(() => {
    const previousTitle = document.title;
    document.title = `${brandName} · Welcome`;
    return () => {
      document.title = previousTitle;
    };
  }, []);

  useEffect(() => {
    if (!hasToken) return;
    let active = true;
    resolveSession(api).then((status) => {
      if (!active) return;
      if (status === 'authenticated') {
        navigate(DASHBOARD_PATH, { replace: true });
      } else {
        setChecking(false);
      }
    });
    return () => {
      active = false;
    };
  }, [api, hasToken, navigate]);

  return checking ? <SessionCheck /> : <WelcomePage />;
}

export default WelcomeRoute;
