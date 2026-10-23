# @salon/plugin-welcome-page

Public, branded welcome page for **Sandra's CRM** at the application root (`/`).

| Route | Behaviour |
| --- | --- |
| `/` | Welcome page for visitors. Signed-in users are sent to the CRM (`/admin`). |
| `/signin` | NocoBase's existing sign-in page (Password and, if enabled, Staff sign-in with Clerk). Unchanged. |
| `/admin/...` | Existing CRM. Unchanged, including its own redirect to `/signin` when signed out. |

## How the root route is integrated

NocoBase 2.2.12 registers a client route named **`root`** at `/` whose element (`RootRedirect`) sends visitors
to `/admin` or `/signin`. The router's supported `router.add(name, route)` replaces a route registered under
the same name. This plugin calls `router.add('root', { path: '/', skipAuthCheck: true, componentLoader })` from
its client `load()`:

- **Legacy client** (`src/client`). This app runs in `legacy-default` entry mode, so `/`, `/signin` and
  `/admin` are served by `@nocobase/client`. This is where the welcome page actually appears.
- **Modern client** (`src/client-v2`). The same override for `@nocobase/client-v2`: `/v/` today, and `/` if the
  entry mode is ever switched to `modern-default`.

No NocoBase core files, database collections, migrations, server routes or ACL rules are added or changed.
Disabling the plugin brings NocoBase's own root redirect back.

`skipAuthCheck: true` marks the route as public, so NocoBase's global 401 handler does not bounce visitors of
the welcome page to `/signin`.

### Session check and redirects

- **No stored session token:** the welcome page renders immediately and no request is made.
- **A stored token:** the page asks the server (`GET /api/auth:check`, through NocoBase's normal auth
  middleware and whichever authenticator issued the session). A confirmed session goes to `/admin` with
  `replace`, so Back doesn't return to `/`. An expired, revoked or invalid token shows the welcome page.
- **No loops:** `/` only redirects after the server confirms the session, and neither `/signin` nor `/admin`
  ever redirects to `/`.

Staff Login is a normal link to `/signin`, so the existing login, including Clerk staff sign-in, is used
unchanged. After sign-in NocoBase opens `/admin`, the same dashboard `/` sends signed-in users to.

## Code layout

```
src/
  client/index.tsx                 legacy client: overrides route "root"
  client/WelcomeRouteV1.tsx        binds the legacy API client
  client-v2/plugin.tsx             modern client: overrides route "root"
  client-v2/pages/WelcomeRouteV2.tsx
  client-v2/shared/
    WelcomeRoute.tsx               session check + redirect (route element)
    WelcomePage.tsx                WelcomeHeader, Hero, StaffLoginButton, FeatureGrid, FeatureCard, WelcomeFooter
    session.ts                     resolveSession(): auth:check based decision (unit tested)
    styles.ts                      scoped CSS (.swp-*), responsive, reduced-motion aware
    icons.tsx                      inline SVG icons (no icon library)
  server/plugin.ts                 empty server plugin (required by the plugin manager)
  locale/en-US.json, zh-CN.json
```

No new dependencies: React, React Router and react-i18next come from the host app.

## Install, enable, run

```bash
# Workspace link. `yarn install` creates it; on Windows it can also be created directly:
#   New-Item -ItemType Junction -Path node_modules\@salon\plugin-welcome-page -Target packages\plugins\@salon\plugin-welcome-page
yarn install

yarn pm enable @salon/plugin-welcome-page   # or Plugin Manager → "Welcome page (Sandra's CRM)" → enable
yarn dev                                     # development (serves the plugin from source)

yarn build @salon/plugin-welcome-page        # production build (dist/), then: yarn start
```

The plugin stays enabled across restarts (the state lives in the `applicationPlugins` table). To turn it off,
use `yarn pm disable @salon/plugin-welcome-page` or the Plugin Manager toggle.

> **Under `yarn dev` in this repository**, `yarn build` and the `yarn pm …` CLI commands rewrite
> `storage/.app-dev/dist/client/index.html(.tpl)` with NocoBase's dev flag set to `false`. The legacy pages
> (`/`, `/signin`, `/admin`) then fail to load local plugins ("App error … `__SECRET_INTERNALS…`"). Restore
> the template and restart `yarn dev`:
>
> ```bash
> cp node_modules/@nocobase/app/dist/client/index.html.tpl storage/.app-dev/dist/client/index.html.tpl
> ```
>
> Enabling or disabling through the Plugin Manager UI doesn't have this problem.
>
> **Restart `yarn dev` after enabling or disabling any local plugin** (Plugin Manager or CLI). NocoBase
> regenerates the dev server's entry files in `storage/.app-dev/plugin-dev/entries/`, and the running
> watcher can rebuild local plugins as empty bundles. Every page then shows "App error: e is not a
> constructor". A restart rebuilds them correctly.

## Tests

```bash
yarn test --server packages/plugins/@salon/plugin-welcome-page
```

`session.test.ts` covers the decision behind `/`: no token means no request, a stored token is confirmed with
`auth:check`, and 401 responses, missing users and network errors all fall back to the welcome page, never a
redirect.
