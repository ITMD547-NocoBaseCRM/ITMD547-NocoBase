# RBAC audit – BeautyWithin CRM (Phase 1)

Taken 2026-11-19 from the running app (NocoBase **2.2.12**, `legacy-default` entry mode) and this repository.
Nothing was changed while auditing. The raw snapshot is in `storage/uploads/rbac-audit-snapshot*.json` (not committed).

## 1. Roles as they are now

| Role name (id) | Title | Default for new users | Data strategy (applies to every collection without its own config) | Configured collections | System snippets | Menu items granted |
|---|---|---|---|---|---|---|
| `root` | Root | no | – (built-in superuser) | – | `pm`, `pm.*`, `ui.*` | all |
| `admin` | Admin | no | create, view, update, destroy, export, importXlsx | none | `pm`, `pm.*`, `ui.*`, `!app` | 70 of 76 |
| `manager` | Manager | no | create, view, update, destroy, export, importXlsx, **trigger, triggerNew** | `users` (view/create/update, incl. `roles` field), `roles` (view) | `pm.*` minus 33 negated settings pages (workflow, plugins, data sources, API keys, env vars, auth, ACL roles, security, logger, backups, …); `!ui.*` | 65 |
| `member` | Member | **yes** | **view** | `employeeShifts` (view, 14 fields), `users` (no actions), `customerNotes` (no actions) | `pm` (settings centre entry), `!pm.*`, `!ui.*` | **61** – almost the whole CRM |
| `receptionist` | Receptionist | no | **none** (the `roles.strategy` column says `view`, but the effective main data-source strategy is empty) | none | `!pm`, `!pm.*`, `!ui.*` | **0** |
| `staff` | Staff | no | **none** (the stale `roles.strategy` column says full CRUD; the effective main data-source strategy is empty) | none | `!pm`, `!pm.*`, `!ui.*` | **0** |

Role mode (`systemSettings.roleMode`) is **`default`**: a user with several roles acts as **one role at a time**
(the role chosen in the role switcher / `X-Role` header, else their default role). Permissions are **not** merged.
So a "Member + Staff" user who is currently in Member only has Member permissions, and one in Staff only Staff.

### Scopes already defined (none are used by any role)

| Scope | Collection | Filter |
|---|---|---|
| Assigned to me (staff) | appointments | `staffId = {{$user.staff.id}}` |
| Assigned to me (staff, via appointment) | payments | `appointment.staffId = {{$user.staff.id}}` |
| Own notes (staff technician) | customerNotes | `staffId = {{$user.staff.id}}` |

`users.staff` (hasOne `staff.userId`) is the user → employee link. Only **Grace Kim ↔ staff_test (user 7)** is linked today.

## 2. Users and role assignments (preserve as is)

| User id | Username | Roles |
|---|---|---|
| 1 | Sandra Admin (admin@nocobase.com) | member, **root**, admin |
| 2 | Pradeep | member, admin, manager (Clerk-linked) |
| 3 | Bori | member, admin, manager |
| 4 | Carolyn | member, admin, manager (Clerk-linked) |
| 5 | Chizalum | member, admin, manager, receptionist, staff (Clerk-linked) |
| 6 | Sandra | member, manager |
| 7 | staff_test (Grace Kim) | member only |
| 8 | receptionist_test | member only |

Verified working admin: user 1 (root) on the password login, plus the Clerk-linked admins.

## 3. Excessive permissions

0. **Member can install, activate and disable plugins.** Its snippets include `pm` ("Allows to install, activate,
   disable plugins" in Roles & Permissions → System). Any account – including a brand-new Member-only account – can
   switch plugins on or off.
1. **Member reads everything.** Default role, effective strategy `view` on every collection: customers (incl. skin sensitivities),
   appointments, payments, consent events, suppressions, customer messages, staff, users… and 61 menu items. Every new
   or unassigned account is effectively a read-only employee.
2. **Staff and Receptionist have no data access at all** (empty main data-source strategy, no collections) yet the
   stale `roles.strategy` column shows Staff as full CRUD. Anyone re-saving the role in the UI from that stale value
   would open every collection to Staff. The rebuild sets both explicitly.
3. **Manager** strategy includes `destroy` everywhere and `trigger`; it can create users and set their `roles`
   (a request-interception workflow "Users: manager account limits" is the only thing stopping escalation to admin).
   Its snippet list is `pm.*` minus a deny list, so **any new plugin settings page is granted by default**.
4. **`@parlour/plugin-appointment-availability`** allows `*` on `staffAvailabilitySchedules`,
   `staffAvailabilityOverrides`, `staffAvailabilityLeaves`, `appointmentAvailabilitySettings` to **any logged-in user**
   (Member included), and `appointmentAvailability:*` (staff names / free slots) to any logged-in user.
5. `customerReviewAdmin:scores` returns **every technician's** scores to anyone who may list appointments (Staff
   would see colleagues' scores once given appointment access).

## 4. Missing restrictions

1. **Receptionist and Staff have no menu items** – they can sign in but see an empty app.
2. No record-level scope on any role: Staff is not limited to their own appointments, customers, shifts or notes.
3. No field-level limits: medical fields (`skinProfile*`, `skinSensitivities*`), consent timestamps, `totalSpent`,
   payments, `users.password`/`resetToken` are readable by any role that can read the parent collection.
4. Statistics, Dashboard and Staff Performance are JS blocks that read `appointments`/`payments` through normal
   collection APIs – they follow the role's ACL, so they show whatever the role can read (no separate guard).
5. No "Access Pending" page; Member lands in the full CRM menu.

## 5. Authentication / role-mapping risks

1. **Clerk role names don't match.** `@salon/plugin-auth-clerk` only lets users with `CLERK_ALLOWED_ROLES` sign in,
   default `admin,r_staff,r_receptionist`. The real roles are `staff`/`receptionist`/`manager`, and `.env` does not
   set `CLERK_ALLOWED_ROLES`. Today only users holding **admin** can use Clerk sign-in; a Staff, Receptionist or
   Manager-only user is refused. (Good: Member-only is refused too.)
2. **Workflow guards check role names that don't exist.** "Staff can only book their own appointments" and
   "Customer notes: ownership guard" test `$context.roleName == 'r_staff' / 'r_receptionist'`, and
   "Users: manager account limits" also refers to `r_staff`/`r_receptionist`. Those branches never run.
3. Clerk identities map to NocoBase users only through admin-created `clerkStaffLinks` (by Clerk user id, never by
   email); roles are read, never written; Clerk metadata is not trusted. Sign-up is restricted to invitations.
   Role/link removals take effect on the next request (≤30 s across nodes). This part is sound.
4. `systemSettings.allowSignUp = true` but the password authenticator has `allowSignUp: false`, so self sign-up is off.
5. Role mode `default`: multi-role users must pick the right role; their default role decides what they see first.

## 6. Custom API endpoints that bypass or sit beside standard ACL

| Endpoint | Who can call it now | Notes |
|---|---|---|
| `customerReviewLinks:inspect/submit` | public | token-gated, rate-limited (T-05) – correct |
| `customerReviewAdmin:*` (except `scores`) | root + roles with snippet `pm.customer-reviews` (admin, manager via `pm.*`) | one snippet = all-or-nothing; Receptionist can't get invitation actions only |
| `customerReviewAdmin:scores` | anyone who may list appointments | returns all technicians |
| `customer_reviews`, `customer_review_*` collections | guarded by snippet | tokens hashed, `tokenHash` stripped |
| `appointmentAvailability:*` | any logged-in user | read-only helpers, expose staff names/free time |
| `staffAvailability*`, `appointmentAvailabilitySettings` | any logged-in user, **all actions** | bypasses role ACL |
| `clerkStaffLinks:*`, `clerkStaffInvitations:*` | root + snippet `pm.auth-clerk` | guarded; Manager has it through `pm.*` |
| `clerkStaffInvitations:accept` | public | Clerk-token authenticated |
| Request-interception workflows | run for every role | business validation; some use wrong role names (above) |

## 7. Proposed changes (to be applied incrementally, see docs/rbac.md)

1. Back up roles, resources, scopes, menu grants and user-role assignments; no role or user is deleted or renamed.
2. **Member**: strategy → no actions, no collections, no snippets; menu → only a new "Access Pending" page.
3. **Manager**: explicit per-collection permissions (no blanket strategy), allow-list snippets (business settings
   only), keep users management limited, deny all system settings.
4. **Receptionist**: explicit collection permissions (manage customers/appointments/notes/shifts/memberships, view
   services/staff basics, no deletes, no price edits, no consent evidence edits), review invitation actions only,
   front-desk menus, no statistics.
5. **Staff**: own appointments / customers of own appointments / own shifts / own notes via `$user.staff.id` scopes,
   minimal customer fields, no payments, no consent, own review scores only (server-enforced), staff menus.
6. Fix the custom endpoints: split the review snippet (manage vs. invitations), force `scores` to the caller's own
   staff record unless they may manage reviews, restrict the availability plugin's writable collections.
7. Fix the Clerk role list (`admin,manager,receptionist,staff`) and the workflow role names.
8. Test every role with its own account against the API and pages; write docs/rbac.md with rollback steps.

## 8. Default roles of multi-role users (role mode `default`)

`*` = default role: user 1 admin*, 3 admin*, 4 admin*, 5 admin*; users 2 and 6 have no default (the first role,
`member`, is used), 7 and 8 member only. The full pre-change state is saved in `scripts/backups/rbac-before.json`.
