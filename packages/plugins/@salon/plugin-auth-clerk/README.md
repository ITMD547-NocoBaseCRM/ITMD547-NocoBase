# @salon/plugin-auth-clerk

Staff sign-in for the salon CRM through [Clerk](https://clerk.com). **Clerk proves who someone is; NocoBase
decides what they may do.** Only staff accounts that an administrator has explicitly linked can sign in, and
the existing NocoBase password login stays available as the administrator fallback.

- Server: a NocoBase authenticator type (`Clerk`) built on `BaseAuth` from `@nocobase/auth`, registered with
  `app.authManager.registerTypes()`. Clerk session tokens are verified with `@clerk/backend@3`.
- Client: Clerk's React `<SignIn>` (`@clerk/react@6`) as a tab on both sign-in pages:
  - `/signin` (legacy client; this app runs in `legacy-default` entry mode, so this is the default page)
  - `/v/signin` (modern client)
- Admin page **Settings → Staff sign-in (Clerk)** (`/admin/settings/auth-clerk` and `/v/admin/settings/auth-clerk`)
  to link, disable and unlink staff accounts.

The public welcome page (`@salon/plugin-welcome-page`, at `/`) links its **Staff Login** button to `/signin`,
where this plugin's Staff sign-in tab appears. After a Clerk sign-in the user lands on `/admin`, the same
dashboard the welcome page sends signed-in users to. This plugin itself does not add or change any routes.

## How sign-in works

1. The staff member opens `/signin` and picks **Staff sign-in**. Clerk's `<SignIn>` handles email/password,
   Google, and "Forgot password?" (all configured in the Clerk Dashboard). Sign-up is hidden in the widget.
2. When a Clerk session exists, the form gets a fresh Clerk **session token** (`getToken()`, ~60 s lifetime) and
   calls `POST /api/auth:signIn` with `X-Authenticator: clerk` and the token in the
   **`X-Clerk-Session-Token` header**. It is never placed in the URL or the body: NocoBase's request log records
   action params (including body values) but only whitelisted headers.
3. The server verifies the token with `verifyToken()`: RS256 signature (JWKS via the secret key, or the PEM in
   `CLERK_JWT_KEY`), `exp`/`nbf`/`iat` (5 s skew), `iss` (from the publishable key or `CLERK_ISSUER`), `azp`
   (must be one of `CLERK_AUTHORIZED_PARTIES`), and `aud` when `CLERK_AUDIENCE` is set. Because the library skips
   iss/azp checks when they are not supplied and only checks `aud` when the token has one, the plugin always
   supplies them and re-checks them itself. It also requires a real session token (`sid` claim), rejects pending
   sessions (`sts`) and impersonation (`act`), and asks the Clerk Backend API that the session is still `active`.
4. The verified Clerk user id (`sub`, e.g. `user_2abc…`) is looked up in `clerkStaffLinks`. Sign-in is refused
   unless the link exists and is enabled, the NocoBase user exists, and the user holds a staff role
   (`CLERK_ALLOWED_ROLES`, default `admin,r_staff,r_receptionist`; the default `member` role is not enough;
   `root` is never allowed). **Nothing in the request body is used.** Browser-supplied user ids, emails or roles
   are ignored. Accounts are never linked by matching email.
5. The NocoBase session is created by `BaseAuth.signIn()` (normal token, cookies, token policy) and recorded in
   `clerkSessionBindings` together with the Clerk session id. Roles are only read, never written.
6. The browser goes to the `?redirect=` target if it is a same-origin path that is not an auth page, otherwise
   to `/admin` (or `/v/admin`). Absolute, protocol-relative and backslash URLs are rejected, and redirects back
   to `/signin` are ignored, so there are no open redirects or loops.

Errors are shown in the form: not linked, disabled, no staff role, session ended, Clerk unreachable, or Clerk not
configured on the server. Clerk loading and the exchange step show spinners.

## Session policy (Clerk session vs. NocoBase session)

A NocoBase token is **independent** of Clerk once issued: signing out of Clerk does *not* by itself invalidate
it. The plugin ties them together explicitly:

| Event | What happens |
| --- | --- |
| Staff signs out of the CRM | `auth:signOut` blocks the NocoBase token **and** revokes the bound Clerk session via the Backend API (best effort; failures are logged and the NocoBase session still ends). |
| Clerk session ends, is revoked (Dashboard, `revokeSession`, sign-out elsewhere) or expires | Each NocoBase request re-confirms the Clerk session status at most every `CLERK_SESSION_RECHECK_SECONDS` (default 300). Once Clerk reports it is not `active`, the NocoBase token is blocked and the user is sent to `/signin`. **Worst-case lag: one recheck interval.** |
| Clerk unreachable | The last successful confirmation is honoured for up to 3 × the recheck interval, then the session is ended (fail closed). |
| Link disabled / removed, or staff role removed | Next request is rejected (link changes take effect immediately on the node that made them; role changes and other cluster nodes within 30 s). |
| NocoBase token policy (Settings → Security → Token policy) | Still applies unchanged (token expiry, renewal, session lifetime). |
| A Clerk-issued token sent with `X-Authenticator: basic` | Rejected by a guard middleware, so the checks above cannot be bypassed. |

On the sign-in page an existing Clerk session is **never used silently**. The form continues automatically only
when the Clerk sign-in started on that page in the last 15 minutes (including the Google round trip). Otherwise it
shows "Continue to the CRM" / "Use a different account", which prevents a sign-out → auto-sign-in loop.

## Configuration

NocoBase plugins have no build-time client environment variables, so **all `CLERK_*` variables are read by the
server**. Only the publishable key reaches the browser, via the authenticator's public options
(`authenticators:publicList`). Secrets are never stored in the database or sent to the client. See the Clerk
section in the root [`.env.example`](../../../../.env.example).

| Variable | Where | Required | Purpose |
| --- | --- | --- | --- |
| `CLERK_PUBLISHABLE_KEY` | server → browser (public) | yes | Loads Clerk in the sign-in form; also used to derive the issuer. |
| `CLERK_SECRET_KEY` | server only, **secret** | yes | Backend API (session status, revocation, user lookup) and JWKS. |
| `CLERK_AUTHORIZED_PARTIES` | server only | yes | Allowed `azp` origins, e.g. `http://localhost:13000,https://crm.example.com`. |
| `CLERK_JWT_KEY` | server only | no | PEM public key for networkless verification (one line, `\n` escapes). |
| `CLERK_ISSUER` | server only | no | Override the issuer (default `https://<Frontend API host>`). |
| `CLERK_AUDIENCE` | server only | no | Require this `aud` (only if you customise the session token). |
| `CLERK_ALLOWED_ROLES` | server only | no | Staff role names (default `admin,r_staff,r_receptionist`). |
| `CLERK_SESSION_RECHECK_SECONDS` | server only | no | Clerk session recheck interval, min 30 (default 300). |

Put real values in `.env` locally (git-ignored) and in `/opt/parlour-crm/app/.env` (or AWS Secrets Manager /
Parameter Store) in production. Restart NocoBase after changing them. Never paste the secret key into chat,
tickets or commits.

### Clerk Dashboard settings

Use the **Development** instance (`pk_test_`/`sk_test_`) locally and a **Production** instance
(`pk_live_`/`sk_live_`) for the deployed CRM. Menu names below follow the current Dashboard and may move.

1. **User & authentication → Email, phone, username**: enable *Email address* (sign-in identifier, verification
   by email code) and *Password*. "Forgot password?" in the widget uses the email code.
2. **User & authentication → SSO connections**: add **Google**. Development instances can use Clerk's shared
   credentials. Production needs your own Google OAuth client: in Google Cloud Console set the authorized
   redirect URI shown by Clerk (on your Frontend API domain, `…/v1/oauth_callback`) and the authorized JavaScript
   origin of your CRM.
3. **Restrictions → Sign-up mode**: choose **Restricted** (invitation only) so random people cannot create Clerk
   accounts. This is defence in depth: an unlinked Clerk account gets no CRM access either way.
4. **Domains** (production): set the CRM's domain and create the DNS records Clerk lists (Frontend API
   `clerk.<your-domain>`). Clerk only redirects to this application's origins, and the widget additionally passes
   `allowedRedirectOrigins: [current origin]`.
5. **Redirect URLs**: the widget always returns to the page it was opened on (`/signin` or `/v/signin`, keeping
   `?redirect=`), including after Google. No extra paths are needed beyond the CRM origin(s) above.
6. **Sessions**: the session token lifetime stays at the 60 s default. Session maximum lifetime and inactivity
   timeout are up to you; ending a Clerk session ends the CRM session within the recheck interval.
7. If you add a Content-Security-Policy, allow your Frontend API host (scripts, connect, frames), `img.clerk.com`,
   and `challenges.cloudflare.com` (bot protection).
8. Keep the session token claims default. Do **not** use a custom JWT template for this plugin (it requires `sid`).

### Sharing Clerk identities with a future app

Another app can use the **same Clerk instance** (same users, same `user_…` ids). Plan for this explicitly:

- The new app uses the same publishable key and its **own server** verifies tokens with the same secret key, with
  its **own** origin in its authorized parties. Add the new origin to that app's config, not to the CRM's
  `CLERK_AUTHORIZED_PARTIES`, unless the CRM should accept it.
- Authorization stays per app: CRM access still requires a `clerkStaffLinks` row, and the other app needs its own
  linking or role mapping keyed by the Clerk user id (never by email).
- Single sign-on is **not automatic**. Clerk shares the browser session between apps on subdomains of the same
  production domain. Apps on different domains need Clerk's satellite-domain setup (plan-dependent). Even with a
  shared Clerk session, each app still issues its own session (the CRM issues a NocoBase token), and signing out
  of the CRM revokes the shared Clerk session for all apps.
- If you set `CLERK_AUDIENCE`, add the `aud` claim in Clerk once for all apps and give each app the values it
  accepts.

## Build, enable and run

From the repository root (Node 22, Yarn 1.22):

```bash
# 1. Install dependencies (adds @clerk/backend and @clerk/react for the workspace plugin)
yarn install

# 2. Build the plugin (server, client, client-v2)
yarn build @salon/plugin-auth-clerk

# 3. Register and enable it (writes to the database configured in .env)
yarn pm enable @salon/plugin-auth-clerk

# 4. Run
yarn dev        # development
yarn start      # production, after `yarn build`
```

> **`yarn dev` + `yarn build` pitfall ("App error … reading '\_\_SECRET_INTERNALS…'").** Under `yarn dev`,
> local plugins are served from source by a dev server (port 14101), and `dist/` is not used. Running
> `yarn build` in this app-install layout rewrites `storage/.app-dev/dist/client/index.html.tpl` with the
> dev flag hard-coded to `false`. The legacy pages (`/signin`, `/admin`) then never provide React to local
> plugins and crash. While developing, skip `yarn build`. If you did run it, restore the template and restart
> `yarn dev`:
>
> ```bash
> cp node_modules/@nocobase/app/dist/client/index.html.tpl storage/.app-dev/dist/client/index.html.tpl
> ```

Enabling runs the plugin's install step. It creates the two tables (`clerkStaffLinks`, `clerkSessionBindings`)
and a **disabled** authenticator named `clerk`. It does not touch existing users, roles, permissions or records.

On Windows without Developer Mode, the NocoBase CLI cannot create symlinks for workspace plugins. If
`node_modules/@salon/plugin-auth-clerk` is missing, create a junction instead:
`New-Item -ItemType Junction -Path node_modules\@salon\plugin-auth-clerk -Target packages\plugins\@salon\plugin-auth-clerk`.

### Go-live checklist

1. Set the `CLERK_*` variables and restart.
2. Sign in with the **password** login as an administrator.
3. **Settings → Staff sign-in (Clerk)**: the info banner must say Clerk is configured (otherwise it lists what
   is missing). Link the first staff accounts (next section).
4. **Settings → Authentication → Authenticators**: enable **clerk** (title "Staff sign-in"). Keep **basic**
   (Password) enabled. Optionally sort `clerk` first so it is the default tab.
5. In a private window, sign in as a linked staff member, check their pages and permissions, then sign out.

## Initial staff linking

Linking is always an explicit administrator action, recorded with `createdBy`:

1. The staff member signs up or is invited in Clerk (Clerk Dashboard → Users → Invite/Create) with the same
   email they use at work.
2. Administrator: **Settings → Staff sign-in (Clerk) → Link staff account**.
3. Search Clerk by **exact email** or **Clerk user ID**. The server queries Clerk; nothing is linked yet.
4. Pick the Clerk account, then pick the **existing** NocoBase user yourself (the email is shown only to help
   you confirm it is the same person). Save. The server re-checks the Clerk user exists. One Clerk account ↔ one
   NocoBase user.
5. Make sure the user has a staff role (Owner/Admin = `admin`, Staff Technician = `r_staff`, Receptionist =
   `r_receptionist`). The table flags users without one. Roles and permissions are managed as before in
   **Users & Permissions**; the plugin never assigns roles.

To remove access: switch **Enabled** off (takes effect on the next request) or **Unlink**. Deleting a NocoBase
user deletes its link.

The same actions are available over the API to administrators (`pm.auth-clerk` ACL snippet):
`clerkStaffLinks:list|create|update|destroy|lookupClerkUsers|configStatus`. `update` only accepts `enabled`
and `note`.

## Administrator fallback

The built-in **Password** authenticator (`basic`) is unchanged. Keep it enabled and keep at least one
administrator with a strong password who does not depend on Clerk. `root` can never sign in through Clerk. If
Clerk is down or misconfigured, the Clerk tab shows an error and administrators use the Password tab.

## Rollback

- **Turn Clerk sign-in off, keep data**: Settings → Authentication → disable the `clerk` authenticator. Existing
  Clerk-issued NocoBase sessions keep working until they expire or are rechecked. To end them at once, also
  disable the links (or the plugin).
- **Disable the plugin**: `yarn pm disable @salon/plugin-auth-clerk`, then restart. The `Clerk` authenticator
  type disappears and Clerk-issued sessions are refused. Users, roles and permissions are untouched. The tables
  remain for a later re-enable.
- **Remove completely**: `yarn pm remove @salon/plugin-auth-clerk` (drops the plugin's tables), delete the
  `clerk` row under Authenticators if it remains, remove the `CLERK_*` variables, then remove
  `packages/plugins/@salon/plugin-auth-clerk` and its `tsconfig.paths.json` entries and run `yarn install`.

## Tests

```bash
# Unit tests (no database): token verification, configuration, redirects
yarn test --server packages/plugins/@salon/plugin-auth-clerk/src/server/__tests__/token-verifier.test.ts
```

The integration tests (`clerk-auth.test.ts`) install a **fresh NocoBase into the configured database, dropping
its tables**. They refuse to run unless `DB_HOST` is local. Give them a disposable local PostgreSQL, for example
with a git-ignored `.env.test` at the repo root:

```bash
DB_DIALECT=postgres
DB_HOST=127.0.0.1
DB_PORT=5432
DB_DATABASE=nocobase_clerk_test
DB_USER=postgres
DB_PASSWORD=<local test password>
```

then:

```bash
yarn build @salon/plugin-auth-clerk          # the integration tests load the built plugin
yarn test --server packages/plugins/@salon/plugin-auth-clerk
```

(Pass the plugin root as the filter; a `__tests__` folder path matches nothing.) If `.env.test` does not exist,
`yarn test` reads `.env`, which points at the shared database, and the guard stops the run. Exported `DB_*`
variables also work and take precedence over the env files. The tests need no Clerk account: tokens are signed
with a throwaway RSA key and only the Clerk Backend API is faked. They run with NocoBase ACL enabled.
