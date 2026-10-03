# Appointment data migration (US-26 / T-41)

**Status: BLOCKED on source-data confirmation.** No appointment data has been migrated and no
migration script exists. This document records what was found, what the target expects, and what
is needed before a migration can be written.

## What the repository contains today

| Finding | Evidence |
| --- | --- |
| No import scripts, CSV, Excel or JSON appointment files | Searched every branch on `origin`; `storage/uploads` holds only a logo |
| No external integration in the current code | `packages/plugins` is empty on `develop` |
| A removed plugin once read **customers only** from an Azure SQL database | Commits `aae8751` and `cf37152` (`@parlour/plugin-crm`, `SELECT ... FROM Customers`); removed in `bc81633` |
| An older README described Azure SQL as holding "customers, appointments, employees, services" | Branch `develop-1`, README project structure |
| The Azure SQL `AZURE_SQL_*` variables are not in `.env.example` or the current `.env` | Current `develop` |
| All 47 appointments in the main database were created inside NocoBase | 12 entered manually on 2026-09-29, 35 seeded by US-01 on 2026-10-02 |
| No collection carries an external or legacy identifier | `fields` table |

The only candidate source is the legacy Azure SQL CRM database. Whether it still exists, whether it
contains an appointments table, and what that table looks like are all unconfirmed.

## Information required to unblock T-41

1. **Source system**: confirmation that the Azure SQL database (or another system) is the source,
   or confirmation that there is no legacy data and T-41 can be closed.
2. **Read access**: server, database, read-only credentials, and firewall access from wherever the
   migration will run. Credentials go in `.env`, never in git.
3. **Schema**: the appointment table definition, including primary key, customer, staff and service
   foreign keys, date/time columns and their time zone, status and category values.
4. **Related entities**: whether the source customers, employees and services already correspond to
   NocoBase `customers`, `staff` and `services` rows, and by which stable key. If they were re-entered
   by hand, a key mapping must be supplied; names are not an acceptable key.
5. **Business rules**: how source categories map to `session` / `event`, how source statuses map to
   the six NocoBase statuses, and whether cancelled or historical rows should be imported.
6. **Volume and cut-off**: approximate row count and whether the import is one-off or repeated.

## Target schema (already in place)

The `appointments` collection is configured by T-40 and prepared by this task.

| Target column | Required | Notes |
| --- | --- | --- |
| `externalSource` | for imported rows | Short code of the source system, e.g. `azure-sql` |
| `externalId` | for imported rows | Source primary key; unique per source (`appointments_external_identity`) |
| `customerId` | yes | Resolved from the source customer key |
| `staffId` | no | Resolved technician; NULL when unassigned |
| `category` | yes | `session` or `event`; default `session` |
| `appointmentDate` | derived | Set by the database from `startTime` (salon time zone); do not supply it |
| `startTime` | yes | Timestamp with time zone |
| `endTime` | no | Must be after `startTime` when present |
| `status` | yes | `scheduled`, `confirmed`, `inProgress`, `completed`, `cancelled`, `noShow` |
| `notes` | no | Free text |
| services | no | One `appointmentServices` row per service, with `priceAtBooking` and `durationAtBooking` |

Both external identity columns stay NULL for appointments created in NocoBase, and the check
constraint `appointments_external_identity_pair` requires them to be set together.

## Expected source mapping

| Source concept | Target | Matching rule |
| --- | --- | --- |
| Appointment id | `externalId` + `externalSource` | Exact; drives idempotency |
| Customer | `customerId` | Source customer id → `customers` external key; email, then phone, only when no stable id exists and the match is unambiguous |
| Type / category | `category` | Explicit value map supplied by the business; unknown values fail the row |
| Service(s) | `appointmentServices` | Source service id → `services`; name only as a last resort |
| Date | `appointmentDate` | Not mapped: the database derives it from the start time |
| Start / end | `startTime`, `endTime` | Converted to UTC; end must be after start |
| Technician | `staffId` | Source employee id → `staff`; missing technician is allowed, unknown technician fails the row |
| Status | `status` | Explicit value map; unknown values fail the row |
| Notes | `notes` | Copied as text |

Customers, staff and services currently have no external key columns. When the source is confirmed,
either add `externalId` to those collections the same way, or supply a one-time key mapping file.

## Failure handling the migration must implement

The staging module `scripts/appointments-import.js` already implements the outcome rules below
without touching any source or the database; the future loader only has to feed it mapped rows.

| Case | Outcome |
| --- | --- |
| Same `externalSource` + `externalId` already in NocoBase | `existing`: skipped, so reruns are safe |
| Same identity repeated inside one batch | `duplicate`: reported, second copy skipped |
| Customer not found or ambiguous | `failed`: reported, never created on the fly |
| Technician given but not found | `failed` |
| Service not found | `failed` |
| Invalid or missing date/time, end before start | `failed` |
| Unknown category or status | `failed` |
| Malformed record or missing identity | `failed` |

Every non-ready row is returned in a report with its index, external id and reasons. Ready rows
should be written inside a transaction through the NocoBase API or `pg`, following the US-01 script
conventions, and the run should be re-executable without creating duplicates.

## Commands

```bash
yarn migrate:appointments-migration-prep     # adds external identity columns, moves no data
yarn validate:appointments-migration-prep    # checks columns, index, constraint, metadata
yarn test:appointments-import                # unit tests for the staging rules
```

For small, one-off manual loads the enabled NocoBase `action-import` (XLSX) plugin can be used
through the Appointments table once a verified spreadsheet exists; it does not replace the rules above.
