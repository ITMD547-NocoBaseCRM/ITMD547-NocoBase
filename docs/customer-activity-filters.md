# Customer activity filters

The Customers page (**Salon Management → Customers**, `/admin/04qxi76dv2b`) lets staff find customers by how they
actually use the salon: inactive for a number of months, most active, new, one-time, repeat, high-value, at risk, or
never visited. Everything is computed from completed appointments and paid payments, on the server. Nothing is typed in.

## What the toolbar offers

| Control | Behaviour |
| --- | --- |
| Search | Name, email or phone (contains). |
| Activity type | One of the rules below. Choosing one also picks the sort that makes it readable; the sort can then be changed. |
| Time period | Last 1 to 6 months or last 12 months, rolling from today. Disabled for rules that do not use it (one-time, repeat, high-value, never visited, most inactive) unless the sort is "most active first". |
| Sort by | Most active first (completed visits in the period), most recent visit first, longest since last visit, highest spending first, newest customers first. Customers without a visit sort last. |
| Status, Birthday, Customer since | Unchanged from before; they combine with the activity rule. |
| KPI tiles | Customers in view, the four status counts, and four activity counts (never visited, inactive N+ months, at risk, new in period) under the other filters. Clicking a tile applies it. |
| Description line | Says in words what the current selection means and the cutoff date it uses, so the meaning is never ambiguous. |
| Export CSV | Includes completed visits, first and last visit and total spent. Import ignores those columns. |

## The rules

A **visit** is an appointment with status `completed`; its time is the appointment start. Scheduled, confirmed,
in-progress, cancelled and no-show appointments are never visits. **Net spending** is the sum of payments with status
`paid` plus `refunded` rows (refunds are negative amounts); pending and failed payments do not count.
"N months" is rolling: on or after the same calendar day N months ago.

| Activity type | Shows | Filter on `customers` |
| --- | --- | --- |
| Inactive for N+ months | Visited before, no completed visit since the cutoff, however long ago | `visitCount >= 1` and `lastVisitAt < cutoff(N)` |
| Last visited N–N+1 months ago | Last visit inside that one-month band | `lastVisitAt < cutoff(N)` and `>= cutoff(N+1)` |
| Most inactive customers | Everyone who visited, longest ago first | `visitCount >= 1`, sorted by `lastVisitAt` ascending |
| Most active in the last N months | At least one visit in the period, most visits first | `visitsLastNm >= 1`, sorted by `-visitsLastNm` |
| New in the last N months | First visit inside the period | `firstVisitAt >= cutoff(N)` |
| One-time customers | Exactly one visit | `visitCount = 1` |
| Repeat customers | Two or more visits | `visitCount >= 2` |
| High-value customers | Net spending above zero, highest first | `totalSpent > 0`, sorted by `-totalSpent` |
| At risk | Regulars (3+ visits) away for N months but seen in the last 12 | `visitCount >= 3`, `lastVisitAt < cutoff(N)`, `lastVisitAt >= cutoff(12)` |
| Never visited | Registered, no completed appointment | `visitCount = 0` |

"Inactive for at least 3 months" and "last visited 3–4 months ago" are different questions, so both are offered.
Customers who never visited are not "inactive": they have their own rule.

The one source of these rules is `scripts/customer-activity-rules.js`. The same file runs in Node (tests, apply
script) and in the browser (injected into the toolbar), so the labels, filters and descriptions cannot diverge.

## How it is built

| Piece | Where |
| --- | --- |
| Database view `customerActivity` | `scripts/migrations/20261013_customer_activity.sql`. One row per customer: `totalVisits`, `firstVisitAt`, `lastVisitAt`, `daysSinceLastVisit`, `visitsLast1m` … `visitsLast6m`, `visitsLast12m`, `totalSpent`, `spentLast12m`. Computed on read. The single definition of the numbers. |
| NocoBase view collection `customerActivity` and relation `customers.activity` | Registered by `yarn apply:customer-activity` (`collections:create`, `fields:create`). Read-only. Live numbers for filters in other blocks and for reports. |
| Activity columns on `customers` | `scripts/migrations/20261013_customer_activity_columns.sql`: `firstVisitAt`, `lastVisitAt`, `totalSpent`, `visitsLast1m` … `visitsLast6m`, `visitsLast12m`, `activityRefreshedAt`, plus the existing `visitCount`. They are a cache of the view. `customers_refresh_activity(ids)` copies the view's values; triggers on `appointments` and `payments` call it for the customers a change touches, immediately. Registered as NocoBase fields by the apply script. |
| Nightly refresh | The rolling counts also move with the calendar, so the NocoBase workflow **Refresh customer activity** (schedule, every day at 03:00 server time, one SQL node: `SELECT customers_refresh_activity();`) refreshes every customer. Created and enabled by the apply script; visible under Workflow settings. Until it has run, counts are at most one day old. |
| Toolbar | `scripts/ui/customers-toolbar.js`, replaced in place on the existing JS block of the Customers page (`flowSurfaces:configure`); block uids do not change. |
| Table columns | "Last visit" and "Total spent" are added to the customers table if missing (`flowSurfaces:addField`). |

Why cached columns and not the relation: NocoBase 2.2 accepts `filter[activity.lastVisitAt]` but builds `ORDER BY` for
an association without its alias, which Sequelize rejects (`Unable to find a valid association for model`). Sorting
"most active first" or "most recent visit first" therefore needs real columns on the customers row. Filters use the
same columns so that what is listed and how it is ordered always agree.

Authorization: the columns live on `customers`, so the role field grants on customers decide who sees spending. If a
role must not see it, remove `totalSpent` from that role's customers field grant (and from `customerActivity`).

## Commands

```bash
yarn migrate:customer-activity          # view, columns, refresh function, triggers + backfill (idempotent)
yarn apply:customer-activity            # register collection, relation, fields and workflow; verify; update the page
yarn apply:customer-activity --check    # report what would change, write nothing
yarn apply:customer-activity --toolbar-only
yarn test:customer-activity             # unit tests, no app needed
```

`apply:customer-activity` targets `http://localhost:$APP_PORT` by default; set `NOCOBASE_API_URL` (for example
`http://<host>:13000/api/`) to target another instance. It stops before touching the page if the server cannot filter
and sort customers by the activity columns, and prints the reason.

Order matters the first time: the migration must run before the apply, because NocoBase refuses to register a view
collection whose database view does not exist. No application restart is needed: `collections:create` and
`fields:create` load the new metadata live.

## Known limitations

- The period is rolling months from today, not calendar months. "Inactive for 3 months" on 13 October means no visit
  since 13 July.
- The cached counts are exact after any appointment or payment change and after the nightly run; between the two,
  a customer can cross a month boundary up to a day late.
- "At risk" uses fixed thresholds (3 visits, 12-month look-back) kept in `scripts/customer-activity-rules.js`.
- Rolling counts exist for 1–6 and 12 months. A different window needs a new view column, a customers column and a
  migration.
