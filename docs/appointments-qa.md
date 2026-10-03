# Appointment management QA (US-26 / T-46)

Integration and browser tests for the Appointments page, run against a live local NocoBase app, with the defects they
found, what was fixed, what is still open, and what a person still has to check by hand.

## Running the suites

| Command | What it runs |
| --- | --- |
| `yarn test:appointments-ui` | Unit tests for the page blueprint, layout, toolbar tabs and the sensitivity indicator (jsdom, no app needed) |
| `yarn test:appointments-collection`, `yarn test:appointments-import` | Unit tests for the schema rules and the import staging code |
| `yarn test:appointments-qa-api` | REST integration tests: CRUD, validation, integrity, filters, sensitivities, and authorization with the real US-19 roles |
| `yarn test:appointments-qa-ui` | Browser tests: the responsive matrix and the user journeys |
| `yarn validate:appointments-collection`, `yarn validate:appointments-ui` | Read the live database and the live page back and check them against the repo |

The two `qa` suites need the app running locally (`yarn dev`) and `.env` with the database and the root login. The
browser suite also needs a Chromium: it uses `playwright-core`, which ships with `@nocobase/test`, and any Chromium in the
Playwright cache or named by `PLAYWRIGHT_CHROMIUM_PATH`. No dependency was added. Without an app or a browser every test
**skips with a reason** instead of failing.

Safety: the suites refuse to run against a non-local app unless `QA_ALLOW_REMOTE=1`. They write real rows, so they stay in
a corner nobody else uses: appointments in March 2027, temporary users named `qa_t46_*`, and temporary customers, staff
and services named `QA-T46`. Everything is removed after the run, and a sweep before the first test removes leftovers of
an interrupted run. The files run one at a time (`--test-concurrency=1`) because they share that range.

## What is covered

| Area | Scenarios |
| --- | --- |
| Create | valid appointment with services; Session and Event; every status; optional technician and end time; required fields and nothing stored when one is missing; invalid category and status; invalid and impossible dates and times; customer, technician and service that do not exist; the date created from the start time (including 9 pm in Chicago, which is already tomorrow in UTC, and an appointment that runs past midnight) |
| Read | list with paging, sorting and relations; details by id; a missing or deleted appointment; an empty result |
| Update | customer, category, status, date and time, technician (including unassigning), notes, booked services (replace, remove without leaving an orphan); invalid changes are refused and leave the record unchanged; an appointment deleted meanwhile |
| Delete | removes the appointment and its service lines, safe to repeat; confirmation, cancel and confirm in the UI; a customer with appointments and a booked service cannot be deleted; deleting a technician leaves appointments unassigned |
| Filters | All, Sessions, Events counts; an empty category; a new Event, an edited category and a deleted record moving between tabs, in the API and in the UI |
| Sensitivities | none, one, several and Other, from the data to the screen; accessible name, click, Enter, Space and Escape; no hover needed; the details drawer; "No sensitivities recorded" wording; no copy on the appointment; the customer's current record is what shows |
| Authorization | r_staff and r_receptionist: list, get by id, create, update, delete, counts, and the columns outside the grant; no session; the relation paths (see open gaps) |
| Errors | refusals explained in plain language; a failing create, delete and list in the browser; a slow list shows a loading state; a record deleted while its edit form is open |
| Responsive | 1440, 1024, 768, 430, 390 and 375px: page and tab overflow, toolbar controls, clipped text, table actions reachable, View, Edit and New popups (drawer on wide screens, full page on phones), Submit reachable, the sub-table and its pager, the delete confirmation, the sensitivity panel |

## Defects found and fixed

1. **Appointments could point at nothing.** The API accepted an appointment for a customer, technician or service that does
   not exist. Foreign keys were added (customer and service `RESTRICT`, technician `SET NULL`).
   `scripts/migrations/20261003_appointment_reference_integrity.sql`, `yarn migrate:appointment-references`.
2. **Removing a booked service left an orphan row.** NocoBase detaches a removed line instead of deleting it. A trigger now
   deletes a line when it is detached. Same migration.
3. **The appointment date was a second, typed field, and the create form lost it.** With the field gone nobody could create
   an appointment. The date is now created from the start time by a trigger (salon time zone, default America/Chicago,
   database setting `crm.salon_timezone`) and removed from the forms. See `docs/appointments-ui.md`.
   `yarn migrate:appointment-date`, then `yarn apply:appointments-ui --forms-only`.
4. **Raw database text reached the user.** An end time before the start time showed
   `new row for relation "appointments" violates check constraint ...`, and deleting a customer or a service in use showed a
   foreign-key error. They now say what is wrong in a sentence. `yarn migrate:appointment-messages`.
5. **The services sub-table footer overlapped itself on narrow screens.** NocoBase positions its pager over "Add new" and
   "Select record". The toolbar now renders a rule that lets the pager flow below the footer. There is no setting for it.
6. **The live create form had drifted from the repo** (the date field removed by hand). `validate:appointments-ui` caught
   it, and `apply:appointments-ui --forms-only` restores any missing field or removes one dropped on purpose in seconds.

## Open gaps (tracked as `todo` tests, so they run and report)

- **Another technician's appointments are reachable through related resources.** The direct appointment list, get, update
  and delete are scoped correctly, but a staff-role login that asks for the same records through a relation gets them.
  Proven with a real restricted account:

  | Path | Result |
  | --- | --- |
  | `staff:list` appending `appointments` | every appointment (49 of 49 at the time) |
  | `customers:get` appending `appointments` | the customer's appointments, including other technicians' |
  | `services:list` appending `appointmentServices.appointment` | other technicians' lines and appointments |
  | `appointmentServices:list` appending `appointment.customer` | another technician's appointment **and its customer's sensitivities** |
  | `appointmentServices:update` | another technician's booked-service price could be changed |

  NocoBase applies a role's row scope to the resource being queried, not to related records loaded with it. The fix is
  not a data change in one place: it needs either explicit field grants that drop the relation fields leading to
  appointments for the technician role (customers, staff, services, booked services, and the collections that reach them),
  an `appointmentServices` scope through the appointment's technician, or a server-side check that applies the scope to
  related loads. I did not apply a partial fix: changing some grants would leave other paths open, change screens other
  stories rely on, and alter a shared environment. This belongs with US-19 / T-45. The T-44 indicator itself only reads
  what the appointments request returns.
- **Technician logins open with a broader role.** `staff_test` holds `r_staff` and `member`, and its default role is
  `member`, which can read and edit every appointment until the user switches role. `Chizalum` defaults to `admin`.
- **A failing list request replaces the table with NocoBase's "Render failed ... internals bug" box**, taking the table's
  action buttons with it. The page does not crash, the toolbar keeps working, and a reload recovers. It is a platform
  error boundary; there is no setting for it.
- **At 430px and below the table actions are icon-only and their accessible names are "plus", "filter" and "reload".**
  NocoBase collapses them and the icon's own label wins over the button's title. A screen reader announces "plus" for New
  appointment.

## Observations that need a product decision (not asserted)

- A technician can create an appointment for another technician or leave it unassigned, and can reassign their own
  appointment to someone else (they then lose sight of it). The scope only restricts what they can read and update.
- The technician role can read every customer, including recorded sensitivities, through the customers resource. That is
  the existing US-19 grant.
- A start time is entered in the browser's time zone, and the date is taken in the salon's. A user in another zone sees
  times shifted from the salon's clock; the date still follows the salon.

## Manual tests that remain

- **Screen readers.** Tab bar, the sensitivity button and panel, and the details drawer with NVDA or VoiceOver. The tests
  prove the accessible names and keyboard behaviour, not how a reader announces them.
- **Real phones.** Safari on iOS and Chrome on Android. The 430, 390 and 375px runs are emulated touch devices.
- **Daylight-saving boundaries** and a user whose browser zone differs from the salon's.
- **Two people editing the same appointment**, and an appointment that runs across midnight.
- **CSV import and export** with the derived date, and a large file.
- **A real technician login** (not a temporary one) switching role in the UI.
- **Print and zoom** (200% browser zoom, large text).

## Last verified results (2026-10-03, local app against the shared dev database)

| Check | Result |
| --- | --- |
| `yarn test:appointments-ui` | 43 pass, 0 fail |
| `yarn test:appointments-collection` / `-import` | 9 pass / 5 pass |
| `yarn test:appointments-qa-api` | 35 pass, 3 todo (the open authorization gaps), 0 fail |
| `yarn test:appointments-qa-ui` | 18 tests: 16 pass, 1 todo (platform "Render failed" box), 1 failed on a test mistake (the platform rethrows the simulated 500 as a page error); the test was corrected and that test re-run alone: pass. The full file was not re-run after that one-line change. |
| `yarn validate:appointments-collection`, `yarn validate:appointments-ui` | ok |
| `yarn lint`, `prettier --check` (scripts, qa, this doc) | clean (`scripts/ui` is prettier-ignored) |
| `tsc --noEmit` | clean; only a few config `.ts` files plus the checked JS are in scope. `scripts/ui` is excluded because those RunJS snippets are not modules and redeclare `React` across files |
| `yarn build` | "No package matched": the `packages` folder is empty, so nothing is built. It proves nothing about this work |
