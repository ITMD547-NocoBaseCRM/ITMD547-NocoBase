# Appointments management UI (US-26 / T-42)

The Appointments page lives in the NocoBase flow-engine (database-stored UI), not in React source.
It is authored declaratively and re-applied through NocoBase's own `flowSurfaces:applyBlueprint`
action, so it runs entirely on the standard `appointments` REST resource with server-side ACL.

Page: **Salon Management → Appointments** (`/admin/7rbhpfmdhv5`).

## What the page contains

| Area | Implementation |
| --- | --- |
| Overview toolbar | JS block (`scripts/ui/appointments-toolbar.js`): status KPI tiles, search, category/status/technician selects, date range, CSV export/import. Binds to the table dynamically. |
| Appointments table | Native table block, 20 rows per page, newest date first. Columns: date, start, end, customer, phone, technician, category, status, services, notes. Filter, refresh, bulk delete. |
| New appointment | Primary button opening a drawer with a create form: customer*, category*, booked services (inline sub-table: service, price, duration, notes), technician, date*, start*, end, status*, notes. |
| View | Drawer with appointment details, an Edit action, and a booked-services table (own view/edit/delete). |
| Edit | Drawer with the same form as create, bound to the current record. |
| Delete | Row action with a confirmation dialog naming the appointment and its services; bulk delete also confirms. |

`*` = required in the form and `NOT NULL` in the database (T-40).

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

- The platform has no default date picker for the `dateOnly` interface, so "Appointment date" is a plain
  text input (`YYYY-MM-DD`), consistent with the Customers page.
- All/Sessions/Events tabs (T-43), the skin-sensitivity warning column (T-44), role-specific
  review (T-45) and final mobile tuning (T-47) are not part of this task.
- A second, older top-level "Appointments" page (`/admin/xw9v0lh863a`) still exists and was not touched.
