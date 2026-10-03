# Appointments management UI (US-26 / T-42, T-43, T-44)

The Appointments page lives in the NocoBase flow-engine (database-stored UI), not in React source.
It is authored declaratively and re-applied through NocoBase's own `flowSurfaces:applyBlueprint`
action, so it runs entirely on the standard `appointments` REST resource with server-side ACL.

Page: **Salon Management → Appointments** (`/admin/7rbhpfmdhv5`).

## What the page contains

| Area | Implementation |
| --- | --- |
| Overview toolbar | JS block (`scripts/ui/appointments-toolbar.js`): All / Sessions / Events tabs, status KPI tiles, search, status/technician selects, date range, CSV export/import. Binds to the table dynamically. |
| Appointments table | Native table block, 20 rows per page, newest date first. Columns: date, start, end, customer, phone, technician, category, status, services, notes. Filter, refresh, bulk delete. |
| New appointment | Primary button opening a drawer with a create form: customer*, category*, booked services (inline sub-table: service, price, duration, notes), technician, start*, end, status*, notes. The appointment date is not asked for: it is created from the start time (see below). |
| View | Drawer with appointment details, an Edit action, and a booked-services table (own view/edit/delete). |
| Edit | Drawer with the same form as create, bound to the current record. |
| Delete | Row action with a confirmation dialog naming the appointment and its services; bulk delete also confirms. |

`*` = required in the form and `NOT NULL` in the database (T-40).

## Type tabs: All / Sessions / Events (T-43)

The tabs sit at the top of the toolbar and filter the table by the T-40 `category` field (`session` or
`event`). Their labels and filters are not written in the toolbar script: `scripts/appointments-schema.js`
(`CATEGORY_TABS`, `getCategoryFilter`) is the single source, injected into the script when the blueprint
is built.

| Behaviour | How it works |
| --- | --- |
| Authorisation | Filtering is always done by the server. The category filter is added to the table's own request and to the count requests, so the signed-in user's role scope is applied together with it. Rows are never fetched to be filtered in the browser. The only unfiltered row request is the table's own first load. |
| All | No category filter: every appointment the user may view. |
| Tab counts | Three one-row requests (`meta.count` only), computed with the other filters (search, status, staff, date) applied, so each tab shows how many records it would list. |
| Switching tabs | One filtered table request plus the five status counts. Tab counts are not refetched because they do not depend on the tab. |
| Create, edit, delete | The table refreshes with the filter still applied, so a new Event appears under Events and not under Sessions, an edited category moves the record between tabs, and a deleted record disappears. The toolbar listens for table refreshes it did not start and refreshes the counts once (bursts are coalesced; page changes are ignored). |
| URL | The tab is kept in `?tab=sessions` / `?tab=events` (replace, no history entries; All leaves the URL clean). A link opens the right tab, and an unknown value falls back to All. Other filters are not in the URL. |
| Empty state | A polite live region explains an empty tab ("No events yet. Set an appointment's category to Event ...") or a filter that matches nothing, with a Clear filters button. Clear keeps the selected tab. |
| Keyboard | antd tabs: arrow keys move focus, Home/End jump. The installed rc-tabs (15.5.2) makes Enter and Space re-activate the current tab instead of the focused one, so the toolbar selects the focused tab itself. |
| Responsive | The three tabs fit within 375px; the toolbar controls wrap. |

The category dropdown that T-42 added to the toolbar was removed: with tabs it would contradict them.

## Customer sensitivity indicator (T-44)

Salon staff see a customer's recorded skin sensitivities on the appointment, in the table and in the details
drawer. The data is US-01's, read through **Appointment → Customer → Skin sensitivities**
(`customers.skinSensitivities`, a text array whose labels come from the field's enum, plus the free-text
`skinSensitivitiesOther`). Nothing is stored on the appointment and no second sensitivity model exists.

| Topic | Behaviour |
| --- | --- |
| Table | A "Sensitivities" column next to the customer. Recorded sensitivities show an amber pill with a warning triangle, the word "Sensitivities" and a count, so the meaning is in the shape and the text, not the colour. Amber, not red: it is a caution to notice, not an error. |
| Details | The View drawer lists every recorded sensitivity inline under "Customer skin sensitivities". |
| Interaction | The pill is a real button. Click, tap, Enter or Space opens a panel with the list; Escape or a click outside closes it. Nothing needs hover. The button's accessible name already carries the full list ("Skin sensitivities recorded: Latex, Essential Oils. Press to show details."), so a screen reader does not need the panel. |
| Wording | No record reads **"No sensitivities recorded"**, never "no sensitivities" or "no allergies": an empty profile means nothing was captured. If the role cannot see the customer's sensitivity fields the cell says "Sensitivity information not available" instead of claiming anything. Free text without the Other option ticked is still shown. |
| Requests | None of its own. The table's single list request already appends the customer relation, so each row arrives with its customer: no per-row request (no N+1). The toolbar's dropdown options now load only `id` and name fields, so customer health data is not loaded into the browser for a dropdown. |
| Authorisation | Through the appointments resource the appointment role scope decides. Verified with a real restricted staff account: it received only its assigned appointment (with that customer's sensitivities), another staff member's appointment returned nothing by id, filtering by another customer returned nothing, and the tab counts were scoped the same way. **This holds for the appointments resource only.** The T-46 tests found that the same appointments, and their customers' sensitivities, can be reached through related resources (staff, customers, services, booked services) because NocoBase does not apply an appointment scope to related records. See `docs/appointments-qa.md`. |

The renderer is `scripts/ui/appointments-sensitivity.js` (a JS field renderer, two variants chosen when the
blueprint is built) and its behaviour is covered by `scripts/appointments-sensitivity.test.js`.

## The appointment date is created from the start time (T-46)

The date used to be a second, free-text field next to the start time. It could disagree with the start time, a bad
value was only caught by the database, and the create form lost the field altogether, which made it impossible to
create an appointment. The database now sets `appointmentDate` itself (a trigger, see
`scripts/migrations/20261003_derive_appointment_date.sql`) whenever `startTime` or the date is written, so the
screens, the REST API and imports all agree. A date sent by a client is replaced by the derived one, and clearing it
restores it. The table, the details drawer and the toolbar's date filter still use the column. `deriveAppointmentDate`
in `scripts/appointments-schema.js` is the same rule in JavaScript, used by the import staging code.

`yarn migrate:appointment-date`, restart NocoBase, then `yarn apply:appointments-ui --forms-only` removes the date
from the live forms.

## Validation and states

- Required fields are enforced by the form and by the database.
- `endTime` must be after `startTime`, `category` and `status` must be valid enum values: enforced by
  database check constraints; the API returns the constraint error and the form shows it as a save error.
- Loading, empty, success and error states are the standard NocoBase block/form states.
- Deleting an appointment cascades to its booked-service lines (`appointment_services_appointment_fk`).
  Payments are never cascaded.
- Relation pickers show names instead of ids because the collections now declare readable title fields.

## Commands

```bash
yarn migrate:appointments-ui-labels        # readable titleField / relation labels (restart app after)
yarn migrate:appointment-services-cascade  # cascade delete of booked-service lines (restart app after)
yarn apply:appointments-ui                 # (re)author the page through flowSurfaces:applyBlueprint, then stack blocks
yarn apply:appointments-ui --layout-only   # only re-stack the live page blocks (seconds, safe to repeat)
yarn apply:appointments-toolbar            # replace only the toolbar script in place (seconds, no-op if unchanged)
yarn validate:appointments-ui              # read the page back and assert the CRUD structure
yarn test:appointments-ui                  # unit tests for the blueprint builder
```

`apply:appointments-ui` signs in with `NOCOBASE_API_TOKEN` or the `INIT_ROOT_*` credentials from
`.env`, targets `http://localhost:$APP_PORT` by default (`NOCOBASE_API_URL` overrides), and can take
several minutes because the server materialises every popup. It is a `replace` of the existing page,
so re-running it is safe; block uids change on each run.

## Layout

- The authoring validator rejects a one-block-per-row layout, so the blueprint writes the toolbar and
  table (and the details and booked services in the View drawer) side by side. The apply script then
  stacks them with `flowSurfaces:setLayout` (`scripts/appointments-page-layout.js`), and
  `validate:appointments-ui` fails if they are not stacked one per row at full width.
- The create and edit forms use an explicit field layout so the booked-services sub-table gets a full-width
  row; in a half-width cell its price and duration columns were clipped.

## Known limitations (follow-ups)

- The appointment date is derived, so it is read-only everywhere. It is the calendar date of the start time in the salon
  time zone (database setting `crm.salon_timezone`, default America/Chicago); an appointment that runs past midnight
  keeps the date it started on.
- All/Sessions/Events tabs (T-43), the skin-sensitivity warning column (T-44), role-specific
  review (T-45) and final mobile tuning (T-47) are not part of this task.
- A second, older top-level "Appointments" page (`/admin/xw9v0lh863a`) still exists and was not touched.
