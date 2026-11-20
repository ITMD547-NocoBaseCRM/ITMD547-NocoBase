# @parlour/plugin-appointment-availability

US-26 staff scheduling and appointment availability for the CRM.

## What it adds

- Weekly staff schedules with effective dates, days off, and multiple working periods.
- Date-specific availability overrides and full- or partial-day leave.
- A single server-side availability engine used by the slot lookup endpoint and appointment create/update validation.
- A responsive NocoBase v2 page at `/v/appointment-availability` and Settings → Appointment availability.

Availability precedence is: active staff, leave, date override, then active employee shifts (including shifts projected from recurring schedules). Cancelled and no-show appointments do not occupy a slot. The business timezone and slot interval are stored in `appointmentAvailabilitySettings` (default: `America/Chicago`, 15 minutes).

Appointment creation, details assignment, and dashboard assignment all call `appointmentAvailability:availableStaff` with the exact start/end instants and, when editing, `excludeAppointmentId`. An empty `staff` array is a normal successful response. The 15-minute interval is only used to suggest slots; it does not restrict manually chosen appointment times.

Shift changes/deletion, date overrides, and staff deactivation are rejected when they would strand active appointments. Reassign or unassign affected appointments first. Booking validation reuses the mutation transaction and also runs when a cancelled/no-show appointment is reactivated.

Scheduling mutations lock the affected staff rows until their transaction commits so concurrent bookings cannot both claim the same time. Bulk shift/override deletion checks the complete removal set. Partial-day leave blocks only its exact interval, and recurring schedule edits create replacement coverage before removing obsolete future shifts while retaining historical shifts.

Native shift create/update requests check saved leave after ACL and before the request-interception workflows. A conflict names the staff member and their leave dates (in the salon timezone), with instructions to choose another staff member/date or update the saved leave. Midnight end dates are exclusive, so leave from Oct 23 to Oct 24 is described as Oct 23 only. Ordinary shift overlaps keep their existing validation.

## Verify and apply an integration update

From the repository root:

```powershell
node --test scripts/appointment-availability-integration.test.js scripts/scheduling-screens.test.js
node scripts/apply-scheduling-integration.js --check
node scripts/apply-scheduling-integration.js --repair-uncovered
node scripts/audit-appointment-shift-staff.js
```

Restart the local NocoBase runtime before applying if the new plugin action is not loaded. The apply command checks the action first, updates all three booking surfaces plus both shift calendars, and optionally unassigns uncovered active bookings without deleting appointments. Dashboard current earnings use the service totals of today's completed appointments; expected earnings also include scheduled, checked-in, and in-progress appointments.

## Enable locally

```powershell
yarn build @parlour/plugin-appointment-availability
yarn pm enable @parlour/plugin-appointment-availability
```

The runtime must be able to load every enabled local plugin before the enable command can finish.
