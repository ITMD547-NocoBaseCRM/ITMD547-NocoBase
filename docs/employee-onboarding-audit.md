# Employee onboarding – audit of the existing implementation (Phase 1)

Taken 2026-11-19 from the running app (NocoBase 2.2.12) and this repository. Nothing was changed while auditing.

## Findings

| # | Question | Finding |
|---|---|---|
| 1 | How employees are created | The **Staff** page (`Beauty Within Portal → Staff`) – a normal table + Add new form on the UI-managed `staff` collection. Fields: firstName, lastName, email, phone, `role` (job title: stylist, therapist, receptionist, manager, admin), specialty, `active` (employment: active, inactive, onLeave), services (m2m via `staffServices`). Admin and Manager can create/edit (RBAC). |
| 2 | How NocoBase users are created | Only by an Admin in Settings → Users & Permissions (password login), or by test scripts. No automatic creation anywhere. New users get the default role `member`. |
| 3 | Clerk → NocoBase user | `@salon/plugin-auth-clerk`: `clerkStaffLinks` maps one Clerk user id ↔ one NocoBase user (both unique). Created by an admin ("Link staff account") or by accepting an invitation. Email is never used to link. |
| 4 | Employee ↔ user relationship | **Exists**: `staff.userId` (bigInt, nullable) with `staff.user` (belongsTo users) and `users.staff` (hasOne). All staff scopes (`{{$user.staff.id}}`) and workflows use it. |
| 5 | Can a user be linked to several employees? | **Yes, nothing prevents it** – `staff.userId` has no unique constraint (only `users.staff` hasOne by convention). |
| 6 | Can an employee be linked to several users? | No – one `userId` column. |
| 7 | How business roles are assigned | Manually by an Admin in Users & Permissions. The Clerk plugin never writes roles; it requires the user to already hold admin/manager/receptionist/staff before inviting or signing in. Default role (which role a multi-role user starts in) can only be set by the user. |
| 8 | Clerk invitations | `clerkStaffInvitations` (Settings → Staff Access → Invite): admin picks an email **and an existing NocoBase user that already holds a staff role**; Clerk emails a ticket link to `/staff-invite`; on sign-up the server verifies the Clerk session, the invitation nonce in Clerk public metadata, that Clerk recorded the invitation as accepted and the email verified, then creates the `clerkStaffLinks` row in a transaction. Resend/revoke supported; expiry derived from `expiresAt` (7 days). Clerk is configured (`allowedRoles` admin, manager, receptionist, staff). |
| 9 | UI for account linking | Only in the admin settings page **Staff Access** (Clerk link ↔ NocoBase user). Nothing links an *employee* to a user except editing `staff.userId` by hand; the Staff page shows no account information. |
| 10 | Active / inactive employees | `staff.active` = active / inactive / onLeave (employment). No account / onboarding state exists. |

## Current data

| Employee | Job title | Employment | Linked user | Clerk link | Invitation |
|---|---|---|---|---|---|
| Grace Kim | stylist | active | 7 `staff_test` (Staff) | – (password login) | – |
| Marcus Reed | stylist | active | – | – | – |
| Priya Patel | therapist | active | – | – | – |
| Hannah Brooks | receptionist | active | – | – | – |
| Sandra A Perez | admin | active | – | – | – |
| Sandra Perez | manager | active | – | – | invitation 6 for user 6 "Sandra" (pending until 2026-11-20) – user 6 is **not** linked to this employee |

Users 2, 4, 5 have Clerk links but are not linked to any employee (team accounts). No conflicting links exist, so a
unique constraint on `staff.userId` can be added safely.

Related data keyed by employee id (must not change): `appointments.staffId`, `employeeShifts.staffId`,
`customerNotes.staffId`, `staffServices.staffId`, `customer_reviews.staffId` / invitations, staff-performance
statistics (computed from appointments/payments by `staffId`). Workflows "Staff can only book their own
appointments" and "Customer notes: ownership guard" resolve the employee from `staff.userId`.

## Changes required

1. Unique constraint on `staff.userId` (one user ↔ one employee).
2. Server-side onboarding service (in the Clerk plugin, which already owns invitations and links): provision
   (create-or-reuse user, assign the chosen business role, link, invite), link an existing user explicitly, resend,
   retry, disable / offboard, reactivate, unlink, audit log, status. Admin only; Manager may view status and
   request provisioning.
3. Account status per employee, derived from the real state (link, roles, Clerk link, invitation) plus a small
   plugin table for things that can't be derived (last error, disabled, provisioning requested) and an audit table.
4. Staff page: an "Employee accounts" panel with status and actions, and "Add employee & invite".
5. A server-resolved "My Workspace" page for Staff (mobile-friendly) reusing the scoped data.
6. RBAC: menu entry for the workspace; nothing else changes.
