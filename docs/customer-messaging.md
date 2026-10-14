# Sending messages to customers (SMS and email)

On the Customers page (**Salon Management → Customers**) the toolbar has a **Send message** button. Select customers
in the table, or filter the list (for example "Inactive for 3+ months"), press it, and a dialog lets the merchant:

| Step | Behaviour |
| --- | --- |
| Recipients | Selected rows, or every customer in the current view (the toolbar's filters, so a campaign can target exactly one activity segment). Shows how many have a phone and how many have an email, and names those who will be skipped. |
| Send by | SMS, Email, or both. A customer without a usable phone gets no SMS; without an email, no email. |
| Subject | Email only. |
| Message | With Email ticked: a rich text editor (bold, italic, underline, heading, bullet and numbered lists, links, images, clear formatting). Images are uploaded to NocoBase file storage and embedded by absolute URL, so the mail client loads them from the app server; keep the server reachable from the internet for that. The email is sent as HTML in a plain, mail-client-safe envelope. SMS always gets the plain text of the same message. Placeholders `{{firstName}}`, `{{lastName}}`, `{{fullName}}` work in both; a live preview shows the rendered email for the first recipient; a 320-character guard applies to SMS. |
| Send | Creates one row per recipient and channel in the **Customer messages** collection with status *Queued*. Delivery happens in the background. |

**Salon Management → Customer messages** lists every message with its status (Queued, Sent, Failed), recipient, text,
time and who sent it. It is the outbox and the history.

## Delivery

The workflow **Deliver customer messages** (Settings → Workflow) fires for every new row:

| Channel | How it is delivered | What the merchant must configure once |
| --- | --- | --- |
| Email | The NocoBase **Email** notification channel (NocoBase gives it an internal name such as `s_eze7ih9g9fo`; the apply script finds it by type, or by `--email-channel <name or title>` / `NOCOBASE_EMAIL_CHANNEL`, and writes that name into the workflow's Send email node) | Settings → Notification management → Channels → add an **Email** channel with the salon's SMTP details. For Gmail: host `smtp.gmail.com`, port 465, secure on, the Gmail address as account, a Google **App Password** (not the login password; requires 2-step verification), and From like `Salon <you@gmail.com>`. Then run `yarn apply:customer-messaging` once. |
| SMS (Twilio, recommended) | The workflow posts directly to Twilio's Messages API (form-encoded To/From/Body, HTTP Basic auth). Phones are normalised to E.164 (`312-555-9001` → `+13125559001`, US by default) when a message is queued; a phone that cannot be normalised is skipped and named in the dialog. | Create a Twilio account, buy a number with SMS (about $1/month; US A2P 10DLC registration is needed for production volume, trial accounts can only text verified numbers). Put `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_FROM=+1XXXXXXXXXX` in `.env`, then run `yarn apply:customer-messaging`. |
| SMS (any other gateway) | HTTP POST with JSON `{ to, body, customerId, messageId }` to a URL | Set `NOCOBASE_SMS_WEBHOOK_URL` (and optionally `NOCOBASE_SMS_AUTH_HEADER`) in `.env` and run the apply. Any webhook works: a Zapier or Make scenario, or a small relay in front of the provider's API. |

After the channel reports success the row is marked *Sent* with a timestamp. If a send fails, the row stays *Queued*
and the failure is visible in the workflow's execution log (Settings → Workflow → executions), including the reason
(bad SMTP login, gateway unreachable, placeholder URL still in place). Nothing is sent twice: each row is processed once.

Until the email channel exists, the dialog shows a warning for administrators and emails stay queued; the notification
manager delivers them once the channel is created. Until a real SMS URL is set, SMS rows fail with a clear error.

## Permissions

Sending requires permission to create rows in `customerMessages`; the Customer messages page requires permission to
view them. Both follow the normal role configuration. Staff roles that may only view customers cannot send.

## How it is built

| Piece | Where |
| --- | --- |
| Definitions (collection, workflow and nodes, page blueprint, placeholder rendering) | `scripts/customer-messaging.js` |
| Apply script (idempotent: collection, fields, workflow, page, toolbar; re-run after changing any provider setting, it creates a new workflow version when needed) | `scripts/apply-customer-messaging.js` → `yarn apply:customer-messaging [--check] [--email-channel <name>] [--sms-provider twilio\|webhook] [--twilio-sid --twilio-token --twilio-from] [--sms-webhook-url <url>] [--sms-auth-header "<value>"]` |
| Dialog | `SendMessageDialog` in `scripts/ui/customers-toolbar.js` (the Customers page toolbar JS block) |

The workflow is a collection event on `customerMessages` (create) with two condition branches: *Email?* →
notification node → update node (status sent); *SMS?* → request node → update node. Variables such as
`{{$context.data.recipient}}` refer to the new row.

## Known limitations

- One message per row, sent individually; there is no provider-side batching or opt-out list yet. Add an
  "accepts marketing" field on customers and filter on it before sending if consent tracking is required.
- Images in emails are links to the app's file storage, not attachments: a mail client that blocks remote images shows them only after "load images". Very large images are not resized.
- Delivery status is "handed to the channel". Bounces and SMS delivery receipts are not read back.
