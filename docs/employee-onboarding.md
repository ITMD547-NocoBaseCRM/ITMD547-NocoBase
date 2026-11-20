# Employee onboarding, CRM accounts and the Staff workspace

NocoBase 2.2.12 · `@salon/plugin-auth-clerk` (onboarding) · `@parlour/plugin-crm` (workspace).
Audit of the starting point: [employee-onboarding-audit.md](employee-onboarding-audit.md). Roles and permissions:
[rbac.md](rbac.md).

Every employee gets **one** CRM account, created or linked by an **Admin**, activated through the existing Clerk
invitation, and tied to the employee record. Technicians then see their own work in **My Workspace**.

## 1. Existing architecture (findings)

- Employees are the UI-managed `staff` collection (Staff page). Employment status is `staff.active`
  (active / inactive / onLeave); job title is `staff.role` (stylist, therapist, receptionist, manager, admin).
- The employee ↔ user relationship already existed: `staff.userId` (`staff.user` belongsTo users, `users.staff`
  hasOne). Every staff permission scope (`{{$user.staff.id}}`) and the booking/notes workflows use it. It was not
  unique.
- NocoBase users were only created by hand. Roles are assigned by an Admin; the Clerk plugin never writes roles.
- Clerk: `clerkStaffLinks` (Clerk user ↔ NocoBase user, admin-created or by invitation) and `clerkStaffInvitations`
  (email + existing NocoBase user with a staff role; accepted on `/staff-invite` after the server verifies the Clerk
  session, the invitation nonce in Clerk public metadata, Clerk's own acceptance and the verified email).
- Only Grace Kim was linked (to `staff_test`). No conflicting links existed.

## 2. Final employee ↔ user relationship

- `staff.userId` → `users.id`, nullable, now **unique** (database constraint; "User ID already exists" on a second
  link). One employee ↔ at most one user; one user ↔ at most one employee.
- No second relationship was added. Employee ids, user ids, appointments, shifts, notes, reviews and statistics are
  untouched (they all key on `staff.id`).
- Links are made only by the onboarding actions (Admin) or by an Admin editing the employee; never by matching
  names or emails. Receptionist/Staff/Member can't write `staff.userId` (RBAC, tested).

## 3. Onboarding workflow (Settings → Staff Access → Employee accounts)

**Add employee & invite** (Admin): employee fields (first/last name, email, phone, job title, specialty) + CRM role
(Staff, Receptionist, Manager; default from the job title). The server, in order:

1. refuses an employee email that already exists (case-insensitive) – "use Invite to CRM on that employee";
2. creates the employee (`employee_created`);
3. provisions the account (below). If that fails the employee stays saved and is marked *Provisioning failed*.

**Invite to CRM / Retry / Send invitation** (`employeeOnboarding:provision`, Admin):

1. validates the role (Staff, Receptionist, Manager only – Admin is never assigned here);
2. uses the employee's linked user if there is one; otherwise, if "Link existing user" was chosen, that exact user
   (must exist, not root, not linked to another employee); otherwise creates a new user from the employee's name and
   email – but refuses if a user with that email already exists and asks the Admin to link it explicitly;
3. links `staff.userId` (`linked`), adds the role if missing (`role_assigned`, never removes roles) and makes it the
   user's default role (unless the user is an Admin), clears NocoBase's role cache;
4. sends the Clerk invitation through the existing `clerkStaffInvitations` service – skipped when the user already
   has a Clerk sign-in, reused when one is pending (`invitation_sent`). Clerk errors are recorded
   (`provisioning_failed`, status *Provisioning failed*) and everything done so far is kept.

Running it again is safe: it never creates a second user, never relinks, never sends a second pending invitation.

**Activation:** the employee opens the email, creates their Clerk sign-in on `/staff-invite`; the existing accept
step verifies everything server-side and creates the Clerk link. A hook then records `activated`. They are signed in
and land on their menu (Staff: My Workspace is second, after Dashboard). Signing in never adds a role.

## 4. Clerk integration

Unchanged and reused: invitations (`createInvitation` with the configured `CLERK_INVITE_REDIRECT_URL`, 7-day
expiry, nonce in public metadata), resend (revokes the old Clerk invitation), acceptance checks, links, session
checks. `CLERK_ALLOWED_ROLES` defaults to admin, manager, receptionist, staff. No Clerk secrets or tokens reach the
browser or the onboarding tables; the invitation nonce is never returned.

## 5. Existing employees (migration)

In Staff Access → Employee accounts every employee without an account shows **No account** with **Invite to CRM** and **Link existing
user**. The Admin checks the name and email, picks the role, and either invites (new account) or links the account
the person already has (chosen from a list of users not linked to any employee; emails shown only to confirm).
Employee ids and all history stay as they are.

Current state: Grace Kim – *Pending activation* (linked to the `staff_test` password account; send her a Clerk
invitation to activate); Marcus Reed, Priya Patel, Hannah Brooks, Sandra Perez, Sandra A Perez – *No account*.
Note: Sandra Perez's work email matches the pending Clerk invitation for user 6 "Sandra"; if that is her account,
use **Link existing user** (it will not be linked automatically).

## 6. Account status

Derived on every read from the real state, plus a small `employeeAccounts` table for what can't be derived:

| Status | Meaning |
|---|---|
| No account (`not_provisioned`) | no linked user |
| Invitation pending | linked user, Clerk invitation pending |
| Invitation expired | linked user, invitation past its expiry |
| Pending activation | linked user, no Clerk sign-in yet (and no pending invitation) |
| Linked / Active | linked user with a business role **and** an enabled Clerk sign-in |
| Provisioning failed | last provisioning step failed (error shown on hover) |
| Disabled | access switched off by an Admin |

An invitation being sent never makes an account Active. Employment status stays separate.

Every action is written to `employeeAccountEvents` (append-only; read-only for Admins, no API writes):
employee_created, user_created, linked, role_assigned, invitation_sent, invitation_resent, provisioning_failed,
provisioning_requested, activated, disabled, offboarded, reactivated, unlinked – with who did it and details.

## 7. Employee management UI

**Settings → Staff Access → Employee accounts** (first tab, next to Link and Invite; Admin only): employee, job
title, employment, CRM role, linked account, account status, invitation (status, expiry), last Clerk sign-in,
actions. Component: `packages/plugins/@salon/plugin-auth-clerk/src/client-v2/shared/EmployeeAccountsPanel.tsx`
(used by both the legacy and the modern client).

**Staff page**: a small block above the employee table. Admins see a pointer with an *Open Staff Access* button;
On the Staff page, Managers see the account status list with **Request account**. Managers can also open Settings → Staff Access for staff accounts (Staff and Receptionist roles); Admin and Manager accounts and giving the Manager role stay with Admins (delegated-access guard).

- Admin: Add employee & invite · Invite to CRM · Link existing user · Resend invitation · Retry · Send invitation ·
  Disable (optionally "the employee has left" = offboard) · Reactivate · Unlink (reason required) · History.
- Manager: sees everything read-only; **Request account** records a request the Admin sees ("Requested …").
  Managers can still create and edit employees (existing table); new employees start as *No account*.
- Everyone else: the panel says they have no access (the API refuses).

## 8. Staff workspace

**My Workspace** (Beauty Within Portal, after Dashboard; Staff role) – one mobile-friendly page:
performance for the last 30 days (completed appointments, completion rate, paid revenue on their appointments,
review average and count, shifts completed, cancelled/no-show), today's appointments (with skin-sensitivity
warnings), upcoming appointments and shifts (15 days), their customers (last 90 days + upcoming; name, phone, skin
profile only), and recent notes (their own and front-desk notes on their customers).

Data comes from `staffWorkspace:get`, which resolves the employee from the signed-in user on the server and filters
every query by that id; review scores come from `customerReviewAdmin:scores`, which returns only the caller's own
scores for Staff. The existing pages (Appointments, Shifts, Customers, Statistics → Staff Performance) stay available
and are already limited to the technician's own records. Checked at 320, 375, 768 px and desktop: single column on
phones, no horizontal overflow.

Appointments have one technician (`appointments.staffId`); multi-technician appointments are not part of the schema.

## 9. RBAC integration

No role changed except menus: Staff gets **My Workspace**; Manager's portal menu excludes it (it needs a linked
employee). Admin sees it too. Everything else is as in [rbac.md](rbac.md). Identity resolution is always
authenticated user → `staff.userId` → employee on the server; a frontend employee id is never trusted.

## 10. Backend security

| Requirement | How |
|---|---|
| Only Admin provisions / assigns roles | `employeeOnboarding:*` (except list, requestProvisioning) needs the `pm.auth-clerk` permission (Admin) – checked in an ACL middleware before any other rule |
| No unauthorized roles | role must be staff / receptionist / manager; Admin never assigned; roles never removed except by Disable (remembered for Reactivate) |
| No duplicates | unique `staff.userId`; existing-user and email checks; per-employee lock; pending-invitation reuse |
| Identity before linking | explicit user choice; root refused; user already linked to another employee refused (409) |
| Secrets | Clerk keys stay server-side; invitation nonce never returned |
| Audit | `employeeAccountEvents` for every action |
| No self-promotion | Member/Staff/Receptionist get 403 on every onboarding action; they can't write `staff.userId` or roles |
| Direct API | onboarding tables: list/get for Admin only, no writes for anyone |
| History kept on disable | employee, appointments, shifts, notes, reviews and statistics untouched |

Failures are recoverable: Clerk, NocoBase and the database are not one transaction, so each step is idempotent and
the employee and user stay in place when a later step fails; Retry continues where it stopped.

## 11. Offboarding

**Disable** (Admin; "the employee has left" also sets employment to Inactive): removes their Manager/Receptionist/
Staff roles (remembered), sets the default role to Member, switches the Clerk sign-in off (sessions end on the next
request), records the action. The user lands on *Access Pending* if they sign in with a password. Nothing is
deleted. **Reactivate** restores the remembered roles, the Clerk sign-in and employment Active. Admin accounts are
not disabled here (remove the Admin role in Users & Permissions first).

## 12. Database changes

- `staff.userId` unique (field option + DB constraint).
- New plugin tables `employeeAccounts` (staffId unique, disabled, disabledRoles, lastError, lastErrorAt) and
  `employeeAccountEvents` (staffId, userId, action, actorId, detail), created at startup if missing.
- UI: Employee accounts JS block on the Staff page; My Workspace page; Staff menu permission.

## 13. Files

| File | Change |
|---|---|
| `packages/plugins/@salon/plugin-auth-clerk/src/server/employee-accounts.ts` | onboarding service |
| `…/src/server/actions/employee-onboarding.ts` | `employeeOnboarding` actions |
| `…/src/server/schema/employee-accounts.ts` | the two tables |
| `…/src/server/plugin.ts` | registration, ACL guard, activation hook, table sync |
| `packages/plugins/@parlour/plugin-crm/src/server/staff-workspace.ts`, `plugin.ts` | `staffWorkspace:get` |
| `…/src/client-v2/shared/EmployeeAccountsPanel.tsx`, `StaffLinksPage.tsx` | Staff Access → Employee accounts tab |
| `scripts/ui/employee-accounts-panel.js` | Staff page block (Admin pointer, Manager status + Request account) |
| `scripts/ui/staff-workspace-block.js` | My Workspace |
| `scripts/onboarding/onboarding-ui-core.js`, `scripts/apply-employee-onboarding.js` | `yarn apply:employee-onboarding [--check]` |
| `scripts/rbac/rbac-spec.js` | My Workspace menu |
| `docs/employee-onboarding-audit.md`, `docs/employee-onboarding.md`, `docs/rbac-test-results.json` | docs, results |

## 14. Tests executed

Against the running app (admin session + separate test accounts), all passing:

- Onboarding scenarios (21): new employee → user created, linked, Staff role (not Admin), Clerk invitation pending;
  retry creates no user and no second invitation; duplicate employee email refused; Admin role refused;
  Manager-created employee shows *No account*; Manager can request but not provision or list users; candidates
  exclude root and linked users; existing user linked with the chosen role; user linked to another employee refused;
  already-linked employee can't be relinked; root can't be linked; Clerk invitation failure keeps employee + user,
  shows *Provisioning failed*, retry reuses the same user; disable removes roles and shows *Disabled*; reactivate
  restores the role; unlink requires a reason; audit history recorded; audit rows can't be deleted via the API;
  Receptionist can't set `staff.userId`; database rejects a second employee on the same user.
- RBAC + onboarding regression suite: **155/155** (`docs/rbac-test-results.json`): Member 35, Staff 42,
  Receptionist 32, Manager 34, Admin 9, public 3 – includes customers, appointments, shifts, notes, services,
  memberships, reviews/invitations, statistics queries, payments, consent, and the new onboarding and workspace
  endpoints (Member/Staff/Receptionist 403 on onboarding; Staff workspace own-only; Member no workspace).
- Workspace endpoint as Grace Kim: own data only; Member 403; users without an employee record get a clear 403.
- UI: Employee accounts panel (Admin) incl. Link dialog; My Workspace at 320/375/768 px and desktop.

Not executed: accepting a real invitation end-to-end (needs a real mailbox and Clerk sign-up in a browser) and
invitation expiry (7 days). Those paths are the existing, unchanged Clerk plugin flow; the status logic for them
was exercised with the API states above.

## 15. Known limitations

1. Deleting a NocoBase user removes its invitation rows (cascade) but not the Clerk-side invitation; revoke it in
   Clerk (or let it expire – it can't be accepted without the row).
2. Password sign-in for disabled accounts still works but only reaches *Access Pending* (no business role).
3. Status "Active" requires a Clerk sign-in; password-only accounts (like `staff_test`) show *Pending activation*.
4. Multi-technician appointments are not supported by the schema.
5. Per-employee locking is per server process; across several nodes the database constraints prevent duplicates.

## 16. Rollback

1. Code: revert the onboarding commit and restart (onboarding actions and the workspace endpoint disappear; tables
   stay, unused).
2. UI: delete the "Employee accounts" block on the Staff page and the "My Workspace" page; remove My Workspace from
   `scripts/rbac/rbac-spec.js` and run `yarn apply:rbac`.
3. Constraint: Settings → Data sources → staff → userId → turn off Unique (optional).
4. Accounts created by onboarding are ordinary users: keep them, or unlink/disable from the panel before reverting.
