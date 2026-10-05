# @parlour/plugin-appointment-availability

US-26 staff scheduling and appointment availability for the CRM.

## What it adds

- Weekly staff schedules with effective dates, days off, and multiple working periods.
- Date-specific availability overrides and full- or partial-day leave.
- A single server-side availability engine used by the slot lookup endpoint and appointment create/update validation.
- A responsive NocoBase v2 page at `/v/appointment-availability` and Settings → Appointment availability.

Availability precedence is: leave, then date override, then recurring schedule. Existing non-cancelled appointments block otherwise valid time. The business timezone and slot interval are stored in `appointmentAvailabilitySettings` (default: `America/Chicago`, 15 minutes).

## Enable locally

```powershell
yarn build @parlour/plugin-appointment-availability
yarn pm enable @parlour/plugin-appointment-availability
```

The runtime must be able to load every enabled local plugin before the enable command can finish.
