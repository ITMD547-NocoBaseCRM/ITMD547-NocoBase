# Customer reviews and Client Review Scores (T-05)

When an appointment is marked **Completed**, NocoBase emails the customer a private, single-use link for each
technician who served them. The customer rates the technician (1–5 stars, optional comment) without signing in,
and the review appears in **Statistics → Staff Performance → Client Review Scores**.

| Piece | Where |
| --- | --- |
| Collections, secure actions, public page, workflow node | Plugin `@salon/plugin-customer-reviews` (`packages/plugins/@salon/plugin-customer-reviews`) |
| Workflow, appointment panel, Customers → Customer Reviews tab, Staff Performance section | `yarn apply:customer-reviews` (`scripts/apply-customer-reviews.js`, definitions in `scripts/customer-reviews.js`, UI code in `scripts/ui/`) |
| Tests | `yarn test:customer-reviews` (pure server logic and UI scripts; no database needed) |

## 1. Architecture findings (Phase 1)

| Question | Finding | Consequence |
| --- | --- | --- |
| NocoBase version, plugins | 2.2.12, PostgreSQL. Workflow (+ notification, mailer, JavaScript, SQL nodes), Notification manager, Email channel, Public forms, ACL, Data visualization. Custom: `@parlour/plugin-crm`, `@parlour/plugin-appointment-availability`, `@salon/plugin-auth-clerk`, `@salon/plugin-welcome-page`. No commercial Email Manager. | New custom plugin `@salon/plugin-customer-reviews`, following the `@salon` plugins' conventions. |
| Email | Email notification channel "BeautyWithinChicago" (Gmail SMTP, port 465, secure), successfully used by the CRM (customer messages, appointment confirmations). | Reviews use **that channel's SMTP transport and sender**. No new email service. |
| Why not the Notification node? | `NotificationManager.send()` writes the full message to `notificationSendLogs` (and the event queue). The review email contains the tokens. | The plugin calls the channel's own pooled nodemailer transport directly; nothing about the body is logged or stored. |
| Workflow trigger | Collection event supports "after update" + "changed fields" + condition. | Fires only when `status` changes to `completed`. |
| Completed appointments | `appointments.status` = `completed` (others: scheduled, confirmed, inProgress, cancelled, noShow). `category` = session/event. | Only completed `session` appointments with a customer are reviewable. |
| Technicians | One technician per appointment: `appointments.staffId → staff`. `appointmentServices` has no technician column (the Staff Performance block states the same). | The code handles several technicians (one invitation and one link per technician, all in one email); today there is always one. If service lines get a `staffId`, those technicians are included automatically. |
| Customers & consent | `emailMarketingOptIn`, `emailTransactionalOptIn` (+ timestamps), `communication_consent_events` (append-only), `communication_suppressions` (never deleted). 42 of 43 customers currently have transactional email **off**. | See the delivery policy below. Most current customers will be *skipped* (correct behaviour). |
| Authentication | Clerk staff sign-in (`@salon/plugin-auth-clerk`) plus NocoBase basic auth. App runs in `legacy-default` entry mode. | Public route registered in the legacy client with `skipAuthCheck` (same as the welcome page); API actions allowed for the `public` role. |
| Public routes | `/` (welcome page), `/staff/accept-invitation`, NocoBase public forms. | `/review` added. |
| Statistics | One JS block per tab (`BW-STATS v5`), Staff Performance block generated from source not in this repo. Filters: This Week / This Month / Last Month / Custom (business time zone from system settings), Technician selector. | Client Review Scores is inserted into that block by the apply script, using its own filters. Original code is backed up. |
| RBAC | Roles admin, manager, staff, receptionist, member (default), root. The **staff** role's data strategy allows create/update/delete on every collection. | The plugin's ACL guard closes the review tables to everyone except root and roles with the `pm.customer-reviews` snippet (admin and manager have it through `pm.*`). |

## 2. Data model

All four collections are defined by the plugin (`src/server/collections`) and created when it is enabled (and on
start if missing). `appointmentId`, `customerId` and `staffId` are plain id columns, **not relation fields and not
database foreign keys**: `appointments`, `customers` and `staff` are UI-managed collections that NocoBase loads after
plugin collections, so a code-defined belongsTo to them fails at startup (the reason `@parlour/plugin-appointment-
availability` also stores only ids). Existing deletes and edits of appointments, customers and staff behave exactly as
before; the service validates the relationships on every write, and the review page looks names up by id. The reverse
"customer/appointment/technician has many reviews" relations are deliberately **not** added as fields on those
collections: an association field would let any role that can read customers append their reviews and bypass the
review permission. Reviews are reached through the review list, the appointment panel and the statistics.

**`customer_reviews`** – id (snowflake), appointmentId, customerId, staffId, invitationId (unique), rating (integer
1–5: model validation + PostgreSQL `CHECK (rating BETWEEN 1 AND 5)`), comment (text, ≤ 1000 characters), status
(`submitted` | `flagged`), submittedAt, createdAt, updatedAt.
Unique index `(appointmentId, staffId)`: at most one review per appointment and technician, enforced by the database.
Model hooks: rows can only be created inside the token-verified submission transaction; rating, comment, ids and
submittedAt can never change; status changes only through moderation; reviews cannot be deleted.

**`customer_review_invitations`** – id, appointmentId, customerId, staffId, tokenHash (unique, hidden), activeKey
(unique; `appointmentId:staffId` while unused and not revoked, NULL afterwards → at most one active invitation per
appointment and technician on any dialect), expiresAt, usedAt, revokedAt, revokedReason, channel (`email` |
`manual`), deliveryStatus (`pending` | `sent` | `failed` | `skipped`), sentAt, sendAttempts, lastSendError
(sanitized), deliveryId, createdById (NULL = the system workflow), createdAt, updatedAt.

**`customer_review_deliveries`** (outbox) – one row per email: appointmentId, customerId, idempotencyKey (unique),
trigger (`workflow` | `manual` | `retry` | `resend` | `regenerate`), status (`pending` | `sending` | `sent` |
`failed` | `skipped`), skipReason/skipMessage, invitationCount, attempts, lockedUntil, sentAt, lastError, messageId,
createdById.

**`customer_review_moderation_events`** (audit, append-only) – reviewId, action (`flag` | `unflag`), fromStatus,
toStatus, reason, createdById, createdAt.

**Migrations.** The plugin owns its schema: `yarn pm enable` creates the tables and indexes; on every start missing
tables are created (deployments run `yarn start` without `nocobase upgrade`, like `@salon/plugin-auth-clerk`), and
the rating CHECK constraint is added once on PostgreSQL. No existing table is altered.

## 3. Delivery eligibility policy

A review invitation is a **service-related feedback request** about an appointment that took place. It is not
marketing, so **marketing opt-in is not required**. It is still an unsolicited message, so the salon's own
transactional preference decides. An invitation email is sent only when **all** hold:

1. the appointment is `completed`, a client `session`, and has a customer;
2. the customer exists and is not `blocked`;
3. the customer has a usable email address;
4. `emailTransactionalOptIn` is **true** (false or empty = no automatic email);
5. no active suppression applies: a `communication_suppressions` row with `active = true`, `liftedAt` empty, channel
   `email` or `all`, purpose `transactional` or `all` (unsubscribe, bounce, complaint, withdrawal, staff-recorded).

Otherwise the email is **skipped** and the reason is recorded (delivery row + appointment panel). The policy never
changes consent fields. Consent is recorded only through the existing consent workflow (`communication_consent_events`).
The emails carry no promotional content. This policy is the salon's choice for this system, not legal advice. Confirm
the rules that apply to the salon (e.g. CAN-SPAM, and TCPA for any SMS) with whoever handles compliance.

**Manual fallback.** Authorized staff can create a link from the appointment panel ("Create link to share") for a
customer without email consent, e.g. at the front desk. Nothing is sent by the system; the link is shown once to that
staff member and is not stored. Staff must share it only through a channel the customer agreed to.

## 4. Automation (workflow)

`yarn apply:customer-reviews` creates and enables **"Customer reviews: invite after completed appointment"**:

| Setting | Value |
| --- | --- |
| Trigger | Collection event, collection **Appointments**, **after record updated** |
| Changed fields | **Status** (an edit of a completed appointment that does not change the status does not trigger) |
| Condition | Status = **completed** |
| Mode | Asynchronous (saving an appointment never waits for SMTP) |
| Node | **Send review invitations** (`customerReviewInvitations`, group "Extended", no settings) |

The node runs the plugin's server-side service, which: loads the appointment, customer and technicians; applies the
policy; creates one invitation per eligible technician who has neither a review nor an active invitation; commits;
then sends **one** email containing all links. The job result stored in the execution history contains only safe
metadata (status, delivery id, number of invitations, skip reason, sanitized error). Tokens never reach workflow
variables, logs or execution history.

**Idempotency and duplicates.** The delivery's `idempotencyKey` is `workflow:<executionId>:<nodeId>` (unique). A
retried or re-run job never sends a second email for the same completion; an interrupted send is finished instead.
Invitation creation is idempotent through the unique `activeKey`: a second completion of the same appointment, or two
concurrent runs, cannot create a second active invitation for the same technician.

**Reliability (outbox).** The delivery row and invitations are committed **before** SMTP is contacted. Sending claims
the row with a compare-and-set update (status + attempt counter) and a 5-minute lock. Success → `sent` + `sentAt` +
`sendAttempts`; failure → `failed` + sanitized `lastError` + `sendAttempts`, and the invitations stay eligible for a
retry. `sent` means the SMTP server accepted the message, not that it reached the inbox (bounces are not read back).

**Exactly-once is not guaranteed** (SMTP has no idempotency key). If the process crashes after Gmail accepted the
message but before `sent` was recorded, the row stays `sending` until its lock expires and a retry sends a second
email. Because only token hashes are stored, every resend issues **new** tokens: links in the earlier copy stop
working, so a duplicate email can never produce a duplicate review. Each attempt has its own `Message-ID`
(`<review-<delivery>-<attempt>@host>`) and `X-Entity-Ref-ID` header.

## 5. Tokens and the public page

* 32 bytes from the OS CSPRNG (256 bits), base64url. Stored only as **HMAC-SHA256 keyed with `APP_KEY`** (a database
  copy alone cannot check guesses). Single use; valid **7 days**; rejected when expired, revoked, used, or when the
  appointment is no longer completed / the customer or technician no longer matches. Changing `APP_KEY` invalidates
  all outstanding links.
* Link: `https://<REVIEW_PUBLIC_BASE_URL>/review#t=<token>`. The token is in the **URL fragment**, which browsers never
  send to a server or in a Referer header, so it is not in server request logs or proxy logs. (T-05 suggested
  `/review/:token`; the fragment is the safer equivalent.)
* The page sends the token only in the `X-Review-Token` header. NocoBase's request logger records the URL, the action
  parameters (request body) and a fixed header whitelist, so neither the URL nor the body carries the token.
* Public API (no sign-in, ACL role `public`, nothing else exposed): `POST /api/customerReviewLinks:inspect` (technician
  name, service names and appointment date only) and `POST /api/customerReviewLinks:submit` (`{ rating, comment }`;
  customer, appointment and technician come from the invitation, never from the browser). Responses: `Cache-Control:
  no-store`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex`. Rate limits per client IP: 60 inspections and
  20 submissions per 15 minutes (in-memory; a multi-instance deployment would need a shared store).
* Submission: one transaction; the invitation row is locked (`SELECT … FOR UPDATE`), consumed with a conditional
  update (`usedAt IS NULL AND revokedAt IS NULL`), the review is inserted; the unique indexes are the final guard.
  Concurrent submissions with the same link create at most one review. A rejected rating or comment does not consume
  the link.
* Page: no third-party resources, `referrer: no-referrer`, `robots: noindex`; native radio group for the stars
  (keyboard arrows, screen-reader labels "4 stars, Very good"), required-rating and length validation with
  `aria-describedby` and `role="alert"`, loading state, double-submit guard, success confirmation, states for invalid,
  expired, revoked, used and ineligible links; works from 320 px. BeautyWithin colours and type as the welcome page.
* **HTTPS:** in production (`APP_ENV`/`NODE_ENV` = `production`) sending refuses a non-https `REVIEW_PUBLIC_BASE_URL`.
  The README notes NocoBase must sit behind HTTPS before production use.

## 6. Staff features and permissions

**Appointment details drawer → "Review invitations"** (admins, managers): email allowed / skipped and why; per
technician the review (stars, comment, status) or the latest invitation (active / expired / revoked / used, emailed /
failed / pending / shared manually, sent at, expires at, attempts, sanitized error); actions **Retry email** (failed),
**Resend email** (sent; re-issues links), **Revoke**, **Send new invitation** (expired or revoked), **Create link to
share** (manual fallback), **Send review invitation now** (when nothing was sent, e.g. the customer opted in later);
delivery history. Every action re-checks eligibility and the email policy and cannot create a second active
invitation or a second review. For other roles the panel is not rendered.

**Customers → Customer Reviews tab** (admins, managers): technician, customer, appointment, rating,
comment, submission date, status; filters (technician, rating, status, date, comment search); **Flag / Remove flag**
with a reason (required to flag). Moderation never edits or deletes the rating or comment and is recorded in
`customer_review_moderation_events` (who, when, from/to, reason), shown in each row's expandable audit trail.

**Client Review Scores** (Statistics → Staff Performance, below Skill demand): average rating out of 5 to one decimal
(sum of ratings ÷ number of reviews), review count, partial-star display, 1–5 distribution; overall average for the
selection; **No reviews yet** for technicians without reviews (never 0 stars). Uses the page's existing date presets
and Technician selector and the business time zone; filters on **review submittedAt**. All submitted reviews count,
including negative and flagged ones (no moderation rule excludes reviews); pending invitations never count.
Technicians are listed alphabetically, not ranked, and averages from fewer than 5 reviews carry a "few reviews" note.
Visible to whoever may list appointments (same audience as the rest of Staff Performance). Other Staff Performance
calculations are untouched.

**Permissions.** `pm.customer-reviews` ACL snippet (admin and manager get it through `pm.*`; configurable per role
under Settings → Users & Permissions). Only root and roles with the snippet can list/get reviews, invitations,
deliveries and moderation events, or run the staff actions; `create`, `update`, `destroy` on these tables are refused
for everyone, including admins (reviews only come from customers).

**Staff API.** Custom actions live on the plain resource `customerReviewAdmin` (`appointmentSummary`, `sendNow`,
`resend`, `revoke`, `regenerate`, `manualLink`, `moderate`, `listReviews`, `scores`), not on the review collections: NocoBase's
flowSurfaces RunJS validator only accepts the standard actions (list, get, create, ...) on collection resources in JS
blocks, and requires JS blocks to read collections through resource APIs rather than raw requests. The Customer Reviews
page therefore gets its rows, with names resolved on the server, from `listReviews`. `scores` is open to any role that may list appointments; every other action requires the snippet.

## 7. How to

**Configure the sender email.** Settings → Notification manager → Channels → the **Email** channel (today
"BeautyWithinChicago"): SMTP host `smtp.gmail.com`, port 465, secure on, the Gmail address as account, a Google **App
Password**, and *From* such as `BeautyWithin <you@gmail.com>`. With several Email channels set `REVIEW_EMAIL_CHANNEL`
(name or title) in `.env`. Set `REVIEW_PUBLIC_BASE_URL` to the address customers reach (e.g. `https://crm.example.com`);
locally it defaults to `http://localhost:13000`.

**Install / enable.** `yarn install`, `yarn pm enable @salon/plugin-customer-reviews`, restart (`yarn dev` or
`yarn start`), then `yarn apply:customer-reviews` (add `--check` first to preview).

**Enable the review workflow.** The apply script enables it. To pause automatic emails: Settings → Workflow →
"Customer reviews: invite after completed appointment" → toggle off (or re-run the apply with
`--keep-workflow-disabled` on a fresh install).

**Complete an appointment and trigger an invitation.** For a customer with transactional email consent and a real
email address, open the appointment and set **Status** to **Completed**, save. Within seconds the drawer's Review
invitations panel shows *Active · Email sent*, and the workflow's execution shows `status: sent`.

**Verify email delivery.** The panel and Settings → Workflow → executions show sent / failed / skipped with the
reason; the Gmail account's *Sent* folder shows the message. (The notification log is intentionally not used.)

**Submit a customer review.** Open the link from the email (or one created with "Create link to share"), choose
stars, optionally comment, **Submit Review**. Opening it again shows "your review is already in".

**View the updated technician rating.** Statistics → Staff Performance → Client Review Scores, with the period that
contains the submission date (e.g. *This Week*), All staff or the technician.

**Retry a failed invitation.** Appointment drawer → Review invitations → **Retry email** (fix the channel first if
the error says the SMTP login failed). Expired or revoked links: **Send new invitation**.

## 8. Known limitations

* Exactly-once email delivery is not possible with SMTP (see §4); duplicates are rare and harmless.
* "Sent" is SMTP acceptance; bounces and complaints are not read back. Record them as suppressions.
* Rate limiting is per process (in memory).
* A link remains valid while the appointment is completed; if the appointment is re-opened (status changed), its
  links stop working, and they work again if it is completed again before they expire.
* Expiry is fixed at 7 days, matching the email text.

## 9. Tests executed (2026-11-19, local dev instance)

**Automated** (`yarn test:customer-reviews`): 20/20 server-logic tests (tokens, policy, eligibility, validation, email
rendering and escaping, score maths, rate limiting) and 18/18 UI/apply tests (panel, Customer Reviews tab, Client Review
Scores section in jsdom; Staff Performance patch idempotency and exact removal; RunJS rule). Not run: database
integration tests against a disposable database (none was available; the Clerk plugin's tests refuse shared databases).

**Live, against the running app (API and browser):**

| Area | Result |
| --- | --- |
| Plugin install, tables, rating CHECK | Enabled; 4 tables created on start |
| Locked tables | create/update/destroy on review tables → 403 for admin; anonymous → 401 on every non-public API |
| Roles (X-Role) | member → 403 on lists and staff actions, 200 on scores; manager and admin → allowed; create review → 403 for all |
| Workflow | Status → Completed sent a real email through the Gmail channel within ~2 s; job result holds only `{status, deliveryId, invitations}`; editing the completed appointment or re-saving Completed → no new execution or email |
| Email policy | Customer without transactional consent → delivery `skipped (transactional_opt_out)`; regenerate also skipped |
| Manual link | Refused before completion and for a non-technician; created link works; token never in API output or database |
| Public page | No sign-in; technician, service, date shown; 320/375 px without horizontal scroll; keyboard star selection; required-rating error; noindex/no-referrer; no external resources |
| Submission | Stored exactly as typed (HTML shown as text); token consumed; reuse → "already in"; 5 replays → `used`; 8 concurrent submits → 1 review; invalid rating/long comment do not consume |
| Link states | replaced → revoked; appointment reopened/cancelled → ineligible, re-completed → valid; revoke → revoked |
| Rate limit | 429 with Retry-After after 20 submissions / 15 min / IP |
| Logs | No token in request/system logs (header not logged) |
| Moderation | Flag needs a reason; flagged still counted; audit events recorded with user and time, cannot be deleted; rating edit → 403 |
| Real customer review | Chizalum's emailed link → 5★ review, visible on the Customer Reviews tab and in the drawer panel |
| Client Review Scores | 3.7 from 3 reviews this week (Grace Kim), "No reviews yet" for others, Last Month → "No reviews yet", technician filter works; Earnings, Retention, appointment counts, revenue and skill demand unchanged |

Not tested live: link expiry after 7 days (unit-tested), an actual SMTP failure and Retry (UI-tested only; breaking the
salon's SMTP settings was not attempted), staff/receptionist roles with real accounts (member role used instead).

**Pre-existing issue found (not part of T-05):** the appointment drawers' Technician JS fields call
`appointmentAvailability:availableStaff`, which `@parlour/plugin-appointment-availability` does not define → "Not Found"
toast and "Staff availability could not be checked" when an appointment is viewed.

## 10. Files

New: `packages/plugins/@salon/plugin-customer-reviews/**`, `scripts/customer-reviews.js`,
`scripts/apply-customer-reviews.js`, `scripts/customer-reviews.test.js`, `scripts/ui/appointment-review-invitations.js`,
`scripts/ui/customer-reviews-admin.js`, `scripts/ui/staff-review-scores.js`, `docs/customer-reviews.md`.
Modified: `package.json` (`apply:customer-reviews`, `test:customer-reviews`); `tsconfig.paths.json` and `yarn.lock`
(by `yarn install`). In the database (UI): the review workflow, the panel in the 5 appointment-details drawers, the
Customer Reviews tab, and the Client Review Scores section inside the Staff Performance block
(`yarn apply:customer-reviews --remove-statistics` removes it and restores the original code exactly).

## 11. Removing the QA test data

Reviews cannot be deleted through the app by design, so test reviews need SQL. Run against the dev database only:

```sql
-- QA records created during T-05 testing
WITH qa_appointments AS (
  SELECT id FROM appointments WHERE notes LIKE 'T-05 QA test appointment%'
)
DELETE FROM customer_review_moderation_events WHERE "reviewId" IN (SELECT id FROM customer_reviews WHERE "appointmentId" IN (SELECT id FROM qa_appointments));
DELETE FROM customer_reviews             WHERE "appointmentId" IN (SELECT id FROM appointments WHERE notes LIKE 'T-05 QA test appointment%');
DELETE FROM customer_review_invitations  WHERE "appointmentId" IN (SELECT id FROM appointments WHERE notes LIKE 'T-05 QA test appointment%');
DELETE FROM customer_review_deliveries   WHERE "appointmentId" IN (SELECT id FROM appointments WHERE notes LIKE 'T-05 QA test appointment%');
```

Then delete the QA appointments (search "T-05 QA" on Appointments → List View) and the customer
"QA Review-Skip (T-05 test)" in the app, so the CRM's own hooks run. To keep Chizalum's real review, add
`AND notes NOT LIKE '%real email%'` to each appointment filter above. Chizalum's consent event is append-only by design;
record a "withdrawn" event if it should be reversed.
