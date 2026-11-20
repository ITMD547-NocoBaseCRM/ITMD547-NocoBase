# BeautyWithin CRM – Role-Based Access Control

NocoBase 2.2.12. Applied 2026-11-19. Audit of the previous state: [rbac-audit.md](rbac-audit.md).
Live test results: [rbac-test-results.json](rbac-test-results.json) (155/155 passed, including the employee-onboarding checks).

The five roles keep their identifiers (`admin`, `manager`, `member`, `receptionist`, `staff`; plus NocoBase's
built-in `root`). No role, user or role assignment was deleted or renamed. NocoBase stays the only place that
decides permissions; Clerk only proves identity.

## 1. How it is enforced

| Layer | Mechanism |
|---|---|
| Collections | Every business role has an **empty data strategy**: a collection is readable only if the role lists it. Admin keeps NocoBase's "all collections" strategy. |
| Actions | Per collection: create / view / update / destroy / export / import, configured in `scripts/rbac/rbac-spec.js`. |
| Records | Scopes (row filters) using the signed-in user's linked staff record, `{{$user.staff.id}}`, resolved on the server. Each staff scope also requires the id to exist, so an account with no staff record sees nothing. |
| Fields | Field allow-lists per action. Fields of **related records** (`appends`) are trimmed by a server middleware in `@parlour/plugin-crm` (`association-field-guard.ts`) to what the role may see on that record's own collection; related collections the role can't read are removed. |
| Menus/pages | Role menu permissions (desktop routes, including tabs). Not a security boundary: every page's data comes from the API above. |
| Custom endpoints | Each plugin guards its own actions (see §8). |
| Business rules | Existing request-interception workflows (staff books only themselves, note ownership, consent rules, manager limits) – role names fixed. |

Role mode stays **one role at a time** (NocoBase "independent roles"): a user with several roles acts as the role
selected in the avatar menu, or their default role. Permissions are never merged, so Member can't widen anything.

## 2. Final role–permission matrix

| Module | Admin | Manager | Member | Receptionist | Staff |
|---|---|---|---|---|---|
| Dashboard | Full | Full | – | View | Own appointments |
| Customers | Full | Full | – | Create / view / edit (no delete, no spend totals) | Customers of own appointments, service fields only |
| Appointments | Full | Full | – | Create / view / edit / reschedule / cancel (no delete) | Own: view; edit status & notes; book for themselves |
| Booked services | Full | Full | – | Manage lines of an appointment | Own, view |
| Services & categories | Full | Manage | – | View | Services they perform, view |
| Memberships (plans, benefits) | Full | Manage | – | View | – |
| Customer memberships | Full | Manage | – | Create / view / edit | – |
| Payments | Full | Manage | – | – | Own appointments, amounts only (for own performance) |
| Employees (staff) | Full | Manage | – | Names, role, specialty | Own record |
| Employee shifts & availability | Full | Manage | – | Create / view / edit | Own, view |
| Customer notes | Full | Manage | – | Create / view / edit | Own notes + unassigned notes on own customers; edit own |
| Customer reviews | Full | Moderate, invitations, all scores | – | Review status; send / resend / regenerate invitations | Own scores |
| Communication preferences | Full | Record consent, manage suppressions | – | View; record consent (opt-ins need evidence) | – |
| Revenue & client retention statistics | Full | View | – | – | – |
| Staff performance | Full | View | – | – | Own |
| Messages, reminders | Full | Manage | – | – | – |
| Workflows, plugins, collections, API keys, variables & secrets, authentication, users & permissions, system settings, UI configuration | Full | – | – | – | – |

## 3. Collection-level permissions

C = create, V = view, U = update, D = destroy, E = export, I = import. `[own]` = record scope (§4), `{n}` = field list (§5).

| Collection | Manager | Receptionist | Staff |
|---|---|---|---|
| customers | CVUDEI | C{edit} V{view} U{edit} | V[own customers]{service} |
| appointments | CVUDEI | CVU | C, V[own], U[own]{status, notes} |
| appointmentServices | CVUDEI | CVUD | V[own] |
| appointments_time_view | VE | V | V[own] |
| services, serviceCategories, staffServices | CVUDEI | V | V[performed], V, V[own] |
| memberships, membershipBenefits | CVUDEI | V | – |
| customerMemberships | CVUDEI | CVU | – |
| payments | CVUDEI | – | V[own appointments]{amount, date, type, status} |
| staff | CVUDEI | V{names, role, specialty} | V[own] |
| employeeShifts | CVUDEI | CVU | V[own] |
| staffAvailabilitySchedules / Overrides / Leaves | CVUDEI | CVU | V[own] |
| appointmentAvailabilitySettings | VU | V | V |
| customerNotes | CVUDEI | CVU | C{note, customer, staff}, V[own + own customers], U[own]{note} |
| customerActivity | VE | V{no spend} | V[own customers]{no spend} |
| customerSavedViews | C, VUD[own] | C, VUD[own] | C, VUD[own] |
| customerMessages | CVE | – | – |
| appointmentReminders / ReminderSettings | V / VU | – | – |
| communication_consent_events | CVE (append-only) | CV | – |
| communication_suppressions | CVU (never deleted) | V | – |
| users | V{id, name, username, email, staff} | V{id, name, username} | V{id, name, username} |
| roles | V{name, title} | – | – |
| customer_review* tables | via snippet `pm.customer-reviews` | – | – |

Member: no collections at all. "All fields" lists also include one level of related-field paths (for example
`customer.firstName`) so the custom dashboard and statistics blocks work; related records are still trimmed (§5).

## 4. Record-level restrictions (server-side scopes)

| Scope | Filter |
|---|---|
| Assigned to me (staff) – appointments | `staffId` exists **and** `= $user.staff.id` |
| RBAC staff: own appointment times | same on `appointments_time_view` |
| RBAC staff: services on own appointments | `appointment.staffId = $user.staff.id` |
| RBAC staff: customers of own appointments | `appointments.staffId = $user.staff.id` |
| RBAC staff: activity of own customers | `customer.appointments.staffId = $user.staff.id` |
| RBAC staff: own and own-customer notes | `staffId = me` **or** (no technician **and** customer has an appointment with me) |
| Own notes (staff technician) – edit | `staffId = me` |
| RBAC staff: own shifts / leave / schedules / overrides / service links | `staffId = me` |
| RBAC staff: own staff record | `id = me` |
| RBAC staff: services I perform | `staff.id = me` |
| Assigned to me (staff, via appointment) – payments | `appointment.staffId = me` |
| RBAC: own saved views | `createdById = $user.id` |

The staff id comes from the server (`users.staff`, i.e. `staff.userId`), never from the browser. Scopes apply to
list, get, update, association lists and the statistics `:query` endpoint; filters, ids and exports can't widen
them (tested). Staff technicians' appointments have a single `staffId`; booked-service lines inherit it.

## 5. Field-level restrictions

| Role | Hidden / read-only |
|---|---|
| Receptionist | Customers: `totalSpent`, payments hidden; consent flags readable but changed only through consent events; staff email/phone hidden; no payment data anywhere (removed from related records too). |
| Staff | Customers: only name, phone, status, skin profile/sensitivities, visit counts. No email, address, date of birth, notes, consent, spend. Payments: no method, reference, customer. Appointments: may change only `status` and `notes`. |
| Manager | Users: no password, reset token or roles. |
| Member | Nothing. |

## 6. Page and menu visibility

| Role | Menu |
|---|---|
| Admin | unchanged (all pages and settings) |
| Manager | Beauty Within Portal: Dashboard, Customers (List, Customer Notes, Customer Reviews tabs), Staff, Appointments, Shifts, Services, Memberships, Payments, Messages (Send, History, Appointment Reminder tabs), Statistics (all tabs). The standalone Customer Notes, Message History and Reminder Settings pages stay hidden (they duplicate those tabs). Settings centre: only **Appointment availability, Staff Access and Mobile** (see below). |
| Receptionist | Dashboard, Customers (List, Customer Notes, Customer Reviews), Appointments, Shifts, Services, Memberships (+ hidden detail pages they link to) |
| Staff | Dashboard, **My Workspace** (see employee-onboarding.md), Appointments, Shifts, Customers (List, Customer Notes), Services (Service List), Statistics → Staff Performance only |
| Member | **Access Pending** page only (top-level). Own profile, language and sign-out stay in the avatar menu. |

Typing a URL for a page that isn't granted shows 404, and its data API answers 403. Settings URLs still draw the
settings shell for non-admins, but every settings API answers "No permissions".

## 7. Clerk role mapping (verified in code and settings)

- Clerk identities map to NocoBase users only through admin-created `clerkStaffLinks` (by Clerk user id; email is
  never trusted). Roles are read from NocoBase and never written; Clerk metadata is ignored.
- Sign-in requires a staff role. The default list was `admin, r_staff, r_receptionist` – names that don't exist here –
  so only Admins could use Clerk. Now `admin, manager, receptionist, staff`
  (`packages/plugins/@salon/plugin-auth-clerk/src/server/config.ts`; `CLERK_ALLOWED_ROLES` still overrides).
  A Member-only account is refused at Clerk sign-in (it can still use the password login and lands on Access Pending).
- New accounts get only `member` (the default role). Self sign-up is off on the password authenticator; Clerk
  sign-up is invitation-only. Users can't pick roles they don't hold: the server rejects an `X-Role` the user
  doesn't have (401 `ROLE_NOT_FOUND_FOR_USER`).
- Role or link changes take effect on the next request (role cache ≤ 30 s across nodes).
- Not testable here: the Clerk sign-in itself (needs a real Clerk session in a browser). The role check it uses was
  verified in code; run the Clerk plugin's tests where `vitest` works (they were updated for the new role names).

## 8. Customer review authorization

| | Admin | Manager | Receptionist | Staff | Member / public |
|---|---|---|---|---|---|
| List reviews, review status | ✓ | ✓ | ✓ | – | – |
| Send / resend / regenerate / manual link | ✓ | ✓ | ✓ | – | – |
| Revoke invitation, moderate | ✓ | ✓ | – | – | – |
| Scores | all | all | – | own only (server picks the staff id) | – |
| Edit ratings | nobody (blocked for everyone) | | | | |
| Submit via link | – | – | – | – | public, token-only |

New snippet `pm.customer-reviews.invitations` (Receptionist). Tables stay snippet-guarded; token hashes are never
returned.

## 9. Communication consent authorization

- Consent history is append-only and suppressions are never deleted (existing workflows).
- Opt-ins: Admin, Manager **and now Receptionist**, always with consent source, wording version and evidence
  (workflow "Consent history: validate new events", new version). Opt-outs: anyone who may record consent.
- Suppressions: Admin/Manager only. Staff and Member can't read or write consent data.
- Customer consent flags can't be edited directly (existing customer guard); Receptionist's customer edit field list
  excludes them as well. No consent was enabled by these changes.

## 10. Workflows and system settings

Only Admin (and root) can configure workflows, plugins, collections, API keys, variables, authentication,
users & permissions, backups, system settings and the UI. Business users still trigger workflows through normal
actions (completing an appointment still sends review invitations) without access to the workflows themselves.

Workflow versions changed (old versions kept, disabled):

| Workflow | Change |
|---|---|
| Staff can only book their own appointments | role check `r_staff` → `staff` |
| Customer notes: ownership guard | `r_staff`/`r_receptionist` → `staff`/`receptionist` |
| Users: manager account limits | allowed roles → `receptionist`, `staff`, `member` |
| Consent history: validate new events | Receptionist may record opt-ins with evidence |

## 11. Files

| File | Purpose |
|---|---|
| `docs/rbac-audit.md` | Phase 1 audit |
| `docs/rbac.md` | this document |
| `docs/rbac-test-results.json` | live test results |
| `scripts/rbac/rbac-spec.js` | the permission matrix as data |
| `scripts/rbac/rbac-core.js` | idempotent applier (scopes, roles, collections, fields, menus, Access Pending page) |
| `scripts/rbac/verify-rbac.js` | live API test suite (145 checks) |
| `scripts/rbac/rbac.test.js` | static spec tests (`yarn test:rbac`) |
| `scripts/apply-rbac.js`, `scripts/rollback-rbac.js` | `yarn apply:rbac [--check]`, `yarn rollback:rbac [--check]` |
| `scripts/backups/rbac-before.json` | permissions and assignments before the change |
| `packages/plugins/@parlour/plugin-crm/src/server/association-field-guard.ts` (+ `plugin.ts`) | related-record field trimming |
| `packages/plugins/@parlour/plugin-appointment-availability/src/server/plugin.ts` | availability tables follow role ACL; helpers need booking/shift access |
| `packages/plugins/@salon/plugin-customer-reviews/src/{constants.ts,server/plugin.ts}` | invitations snippet; own-only scores |
| `packages/plugins/@salon/plugin-auth-clerk/…` | allowed role names, docs, tests |
| `.env.rbac-test` (git-ignored) | passwords of the `rbac_manager` / `rbac_member` test accounts |

## 12. Database / configuration changes

- Roles `manager`, `receptionist`, `staff`, `member`: snippets, strategy (role and main data source), collection
  actions, field lists, scopes, menu permissions. `admin`/`root` unchanged.
- 13 new scopes (`RBAC …`), page **Access Pending** (top-level, Member only).
- Four workflow versions (§10).
- Users: `staff_test` +Staff (default Staff), `receptionist_test` +Receptionist (default Receptionist), new
  `rbac_manager` (Member + Manager, default Manager) and `rbac_member` (Member). No other user's roles changed.

## 13. Tests executed

- `yarn test:rbac` – 8 static checks of the spec (pass).
- `scripts/rbac/verify-rbac.js` against the running app, signed in as each test account – **145/145 pass** (latest run: the `rbac_manager`/`rbac_member` accounts had been deleted, so the Manager and Member probes ran with an account holding those roles)
  (Member 32, Staff 38, Receptionist 31, Manager 30, Admin 8, public 3). Covers direct API access, create / read /
  update / delete, association queries, foreign record ids, filters, exports, custom plugin endpoints, statistics
  queries, related-record field trimming and the public review endpoint.
- Visual: Member lands on Access Pending and gets 404 on CRM URLs; Staff dashboard, appointment list (97 = Grace
  Kim's own) and Staff Performance (own only); Receptionist customers (no Delete); Manager statistics (all tabs)
  and "No permissions" on a settings URL.

## 14. Remaining issues and limitations

1. **Users 2 (Pradeep) and 6 (Sandra, Manager)** have no default role, so NocoBase picks their first role,
   `member`, and they will land on Access Pending. They pick their role once in the avatar menu → *Switch role*, or
   set a default there. (NocoBase has no admin API to set someone else's default role.)
2. Some buttons are still drawn for roles that can't use them (Import/Export for Staff, Send Message for
   Receptionist); the server refuses the action.
3. Staff appointment edits save only status and notes; other edits are silently dropped by the field allow-list.
4. Settings URLs show the settings shell (page names) to non-admins; all their data is refused.
5. The availability plugin's helper endpoints answer any role that may book appointments (they reveal staff
   names and free slots – needed for booking).
6. Clerk sign-in was not exercised end-to-end here (§7).
7. Aggregates on customers by Staff count once per joined appointment (statistics only).

## 15. Rollback

1. `yarn rollback:rbac --check`, then `yarn rollback:rbac` – restores every role's snippets, strategies,
   collection permissions and menus from `scripts/backups/rbac-before.json`.
2. Workflows: Settings → Workflow → each workflow in §10 → Versions → enable the previous version.
3. Code: revert the plugin changes (`git revert` the RBAC commit) and restart.
4. Optional: remove the Access Pending page, the `RBAC …` scopes, the roles given to the test users and the two
   `rbac_*` users in Users & Permissions.

## 16. How an Admin manages roles

- **Assign Manager / Receptionist / Staff:** Settings → Users & Permissions → Users → the user → Edit → Roles → add
  the role → Submit. For Staff, also link the user to their employee record: Staff page → the employee → User.
  Without that link a Staff account sees no appointments, customers or shifts.
- **Remove an elevated role:** same screen, remove the role (Member stays). Takes effect on the next request.
- **Review a user's roles:** Users list → Roles column, or Roles & Permissions → a role → Users tab.
- **Default role:** the user chooses it in their avatar menu (Switch role / set as default).
- **Verify a Member-only account is restricted:** sign in with it – only *Access Pending* appears; or run
  `yarn apply:rbac --check` (no changes expected) and the live checks in `scripts/rbac/verify-rbac.js`.
- **Clerk users:** Settings → Staff Access to invite/link; the account must hold Admin, Manager, Receptionist or Staff.

## Manager settings pages

Managers see three settings pages: **Appointment availability**, **Staff Access** and **Mobile** (Customer reviews stays
reachable from Customers → Customer Reviews). The settings menu in both clients hides a page only when the role denies
that page's exact snippet (`!pm.<name>`), and NocoBase drops such multi-part denials unless the role also includes
`pm.*`. The Manager role therefore has `pm.*` plus an explicit denial (exact names and `pm.<family>*` wildcards) of every
other settings snippet registered in this app; `scripts/rbac/rbac.test.js` checks with the server's own matching rule
that only the four pages remain allowed. The legacy `/admin` client has no Appointment availability page and does not
show its deprecated Mobile page to Managers; use `/v/admin/settings`.

Staff Access is delegated for staff accounts only: the Clerk plugin's delegated-access guard
(`delegated-access-guard.ts`) refuses non-admin callers who link, invite, provision, disable, reactivate or unlink a user
holding root, admin or manager, or who give the Manager role. A plugin that adds a new settings page under a new name is
allowed to Managers until it is added to `HIDDEN_SETTINGS` in `rbac-spec.js`, but its APIs keep their own ACL checks.
- **Change permissions:** edit `scripts/rbac/rbac-spec.js`, then `yarn apply:rbac --check` and `yarn apply:rbac`.
  Changes made by hand in Roles & Permissions are reported (and reverted) by the next apply.
