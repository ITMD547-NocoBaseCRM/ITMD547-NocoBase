// Appointment reminders: pure definitions of what is applied to NocoBase (unit-tested; no network here).
//
// A salon owner opens the "Reminder settings" page and selects which pre-appointment intervals should fire
// automated email reminders: 1 hour, 2 hours, 12 hours, 24 hours, 48 hours. Each selected interval means
// clients receive an email reminder that many hours before their appointment.
//
// The system works as:
//   1. `appointmentReminderSettings` — singleton collection: which intervals are on, email template, master switch.
//   2. `appointmentReminders`        — one row per (appointment × interval), tracks pending/sent/failed/cancelled.
//   3. Scheduled workflow "Process appointment reminders" — runs every 15 minutes via two SQL nodes:
//      a) inserts into `customerMessages` for every due reminder (email channel, the existing "Deliver customer
//         messages" workflow fires on each new row and sends the actual email);
//      b) marks those reminders as "sent".
//   4. Server-side hook (plugin.ts) — on appointment create/update: creates reminder rows for each enabled
//      interval; on cancel/noShow/delete: marks pending reminders as "cancelled".
//
// `yarn apply:appointment-reminders` (scripts/apply-appointment-reminders.js) creates everything idempotently.

const { systemFields, MESSAGES_COLLECTION, EMAIL_CHANNEL_NAME } = require('./customer-messaging');

// ─── Constants ───────────────────────────────────────────────────────────────

const SETTINGS_COLLECTION = 'appointmentReminderSettings';
const REMINDERS_COLLECTION = 'appointmentReminders';
const SETTINGS_PAGE_TITLE = 'Reminder settings';
const REMINDERS_PAGE_TITLE = 'Appointment reminders';
const PROCESS_WORKFLOW_TITLE = 'Process appointment reminders';

const INTERVALS = [
  { value: '1h',  label: '1 hour before',   hours: 1 },
  { value: '2h',  label: '2 hours before',  hours: 2 },
  { value: '12h', label: '12 hours before', hours: 12 },
  { value: '24h', label: '24 hours before', hours: 24 },
  { value: '48h', label: '48 hours before', hours: 48 },
];

const REMINDER_STATUSES = [
  { value: 'pending',   label: 'Pending',   color: 'gold' },
  { value: 'sent',      label: 'Sent',      color: 'green' },
  { value: 'failed',    label: 'Failed',    color: 'red' },
  { value: 'skipped',   label: 'Skipped',   color: 'default' },
  { value: 'cancelled', label: 'Cancelled', color: 'default' },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

const select = (name, title, options, extra = {}) => ({
  name,
  type: 'string',
  interface: 'select',
  enum: options,
  uiSchema: { type: 'string', title, 'x-component': 'Select', enum: options },
  ...extra,
});
const text = (name, title, component = 'Input') => ({
  name,
  type: component === 'Input' ? 'string' : 'text',
  interface: component === 'Input' ? 'input' : 'textarea',
  uiSchema: { type: 'string', title, 'x-component': component === 'Input' ? 'Input' : 'Input.TextArea' },
});
const datetime = (name, title) => ({
  name,
  type: 'date',
  interface: 'datetime',
  uiSchema: {
    type: 'string',
    title,
    'x-component': 'DatePicker',
    'x-component-props': { showTime: true, utc: true },
    'x-read-pretty': true,
  },
});
const boolean = (name, title, defaultValue = false) => ({
  name,
  type: 'boolean',
  interface: 'checkbox',
  defaultValue,
  uiSchema: { type: 'boolean', title, 'x-component': 'Checkbox' },
});

// ─── Settings collection ─────────────────────────────────────────────────────
// Singleton row: one settings record for the whole salon.

function settingsCollectionDefinition() {
  return {
    name: SETTINGS_COLLECTION,
    title: 'Reminder settings',
    template: 'general',
    logging: true,
    createdBy: true,
    updatedBy: true,
    createdAt: true,
    updatedAt: true,
    description: 'Salon-wide appointment reminder configuration. One row (singleton): which intervals are enabled, email template, and a master on/off switch.',
    fields: [
      boolean('enabled', 'Enable reminders', true),
      {
        name: 'enabledIntervals',
        type: 'json',
        interface: 'checkboxGroup',
        defaultValue: ['24h', '48h'],
        uiSchema: {
          type: 'array',
          title: 'Reminder intervals',
          'x-component': 'Checkbox.Group',
          'x-decorator': 'FormItem',
          enum: INTERVALS.map((i) => ({ value: i.value, label: i.label })),
        },
      },
      text('emailSubject', 'Email subject'),
      text('emailBody', 'Email body (HTML)', 'TextArea'),
      ...systemFields(),
    ],
  };
}

// Default email template (used when the settings row has no custom template).
const DEFAULT_EMAIL_SUBJECT = 'Reminder: Your appointment is coming up!';
const DEFAULT_EMAIL_BODY = [
  '<p>Hi {{firstName}},</p>',
  '<p>This is a friendly reminder that you have an appointment coming up at <strong>{{appointmentTime}}</strong> on <strong>{{appointmentDate}}</strong>.</p>',
  '<p>If you need to reschedule, please contact us as soon as possible.</p>',
  '<p>We look forward to seeing you!</p>',
].join('\n');

// ─── Reminders collection ────────────────────────────────────────────────────
// One row per (appointment × interval). Created by the server hook when an appointment is booked;
// marked "sent" when the scheduled workflow queues the email; "cancelled" if the appointment is cancelled.

function remindersCollectionDefinition() {
  return {
    name: REMINDERS_COLLECTION,
    title: 'Appointment reminders',
    template: 'general',
    logging: true,
    createdBy: false,
    updatedBy: false,
    createdAt: true,
    updatedAt: true,
    description: 'Tracks one email reminder per appointment and interval. The scheduled workflow finds rows that are due and queues them for delivery.',
    fields: [
      {
        name: 'appointment',
        type: 'belongsTo',
        interface: 'm2o',
        target: 'appointments',
        foreignKey: 'appointmentId',
        targetKey: 'id',
        uiSchema: {
          type: 'object',
          title: 'Appointment',
          'x-component': 'AssociationField',
          'x-component-props': { multiple: false, fieldNames: { value: 'id', label: 'calendarTitle' } },
        },
      },
      {
        name: 'customer',
        type: 'belongsTo',
        interface: 'm2o',
        target: 'customers',
        foreignKey: 'customerId',
        targetKey: 'id',
        uiSchema: {
          type: 'object',
          title: 'Customer',
          'x-component': 'AssociationField',
          'x-component-props': { multiple: false, fieldNames: { value: 'id', label: 'firstName' } },
        },
      },
      select('intervalKey', 'Interval', INTERVALS.map((i) => ({ value: i.value, label: i.label }))),
      datetime('scheduledFor', 'Scheduled for'),
      select('status', 'Status', REMINDER_STATUSES, { defaultValue: 'pending' }),
      datetime('sentAt', 'Sent at'),
      text('error', 'Error', 'TextArea'),
    ],
  };
}

// ─── Workflow: Process appointment reminders (scheduled, every 15 min) ───────
// Pure SQL: node 1 inserts into customerMessages for each due reminder, node 2 marks them sent.
// The existing "Deliver customer messages" collection-event workflow fires on each new customerMessages
// row and delivers the email through the SMTP notification channel.

function processWorkflowDefinition() {
  return {
    title: PROCESS_WORKFLOW_TITLE,
    type: 'schedule',
    enabled: true,
    description: 'Runs every 15 minutes. Finds pending appointment reminders that are due (scheduledFor <= now) and queues email reminders into customerMessages. The "Deliver customer messages" workflow sends them. Created by yarn apply:appointment-reminders.',
    config: { mode: 0, startsOn: '2026-11-11T00:00:00.000Z', repeat: '*/15 * * * *' },
  };
}

// SQL node 1: Insert into customerMessages for every due reminder, joining to get customer email,
// name, and appointment time. Uses COALESCE to fall back to the default template when settings are empty.
// The CTE reads the template once and the INSERT uses it for every row.
function queueDueRemindersSql() {
  const defaultSubject = DEFAULT_EMAIL_SUBJECT.replace(/'/g, "''");
  const defaultBody = DEFAULT_EMAIL_BODY.replace(/'/g, "''");

  return `
WITH settings AS (
  SELECT
    COALESCE("emailSubject", '${defaultSubject}') AS tpl_subject,
    COALESCE("emailBody",    '${defaultBody}')    AS tpl_body
  FROM "${SETTINGS_COLLECTION}"
  ORDER BY id LIMIT 1
),
due AS (
  SELECT
    r.id              AS reminder_id,
    r."customerId",
    c."firstName",
    c."lastName",
    c.email,
    a."startTime",
    TO_CHAR(a."startTime" AT TIME ZONE 'America/Chicago', 'FMDay, FMMonth FMDD, YYYY') AS appt_date,
    TO_CHAR(a."startTime" AT TIME ZONE 'America/Chicago', 'FMHH12:MI AM')              AS appt_time
  FROM "${REMINDERS_COLLECTION}" r
  JOIN appointments a ON a.id = r."appointmentId"
  JOIN customers    c ON c.id = r."customerId"
  WHERE r.status = 'pending'
    AND r."scheduledFor" <= NOW()
    AND a.status IN ('scheduled', 'confirmed')
    AND c.email IS NOT NULL AND c.email <> ''
  ORDER BY r."scheduledFor" ASC
  LIMIT 100
)
INSERT INTO "${MESSAGES_COLLECTION}" (channel, recipient, subject, body, "bodyHtml", status, "customerId", "createdAt", "updatedAt")
SELECT
  'email',
  d.email,
  REPLACE(REPLACE(REPLACE(REPLACE(s.tpl_subject,
    '{{firstName}}', COALESCE(d."firstName",'')),
    '{{lastName}}',  COALESCE(d."lastName",'')),
    '{{appointmentDate}}', d.appt_date),
    '{{appointmentTime}}', d.appt_time),
  REPLACE(REPLACE(REPLACE(REPLACE(s.tpl_body,
    '{{firstName}}', COALESCE(d."firstName",'')),
    '{{lastName}}',  COALESCE(d."lastName",'')),
    '{{appointmentDate}}', d.appt_date),
    '{{appointmentTime}}', d.appt_time),
  '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#111827;max-width:640px">' ||
  REPLACE(REPLACE(REPLACE(REPLACE(s.tpl_body,
    '{{firstName}}', COALESCE(d."firstName",'')),
    '{{lastName}}',  COALESCE(d."lastName",'')),
    '{{appointmentDate}}', d.appt_date),
    '{{appointmentTime}}', d.appt_time) || '</div>',
  'queued',
  d."customerId",
  NOW(),
  NOW()
FROM due d, settings s;
  `.trim();
}

// SQL node 2: Mark the same set of due reminders as "sent" (same WHERE as above).
function markDueRemindersSentSql() {
  return `
UPDATE "${REMINDERS_COLLECTION}"
SET status    = 'sent',
    "sentAt"  = NOW(),
    "updatedAt" = NOW()
WHERE status = 'pending'
  AND "scheduledFor" <= NOW()
  AND "appointmentId" IN (
    SELECT a.id FROM appointments a WHERE a.status IN ('scheduled', 'confirmed')
  )
  AND "customerId" IN (
    SELECT c.id FROM customers c WHERE c.email IS NOT NULL AND c.email <> ''
  );
  `.trim();
}

function processWorkflowNodes() {
  return [
    {
      key: 'sql_queue_messages',
      type: 'sql',
      title: 'Queue email reminders',
      config: { dataSource: 'main', sql: queueDueRemindersSql(), withMeta: false },
    },
    {
      key: 'sql_mark_sent',
      upstream: 'sql_queue_messages',
      type: 'sql',
      title: 'Mark reminders sent',
      config: { dataSource: 'main', sql: markDueRemindersSentSql(), withMeta: false },
    },
  ];
}

// ─── Settings page blueprint ─────────────────────────────────────────────────
// An edit form for the singleton settings row, plus a table of the reminders log below.

function settingsPageBlueprint({ pageSchemaUid }) {
  return {
    version: '1',
    mode: 'replace',
    target: { pageSchemaUid },
    page: { title: SETTINGS_PAGE_TITLE, documentTitle: SETTINGS_PAGE_TITLE, displayTitle: true, enableTabs: false },
    tabs: [
      {
        key: 'main',
        title: SETTINGS_PAGE_TITLE,
        layout: { rows: [[{ key: 'settings', span: 24 }, { key: 'reminders', span: 24 }]] },
        blocks: [
          {
            key: 'settings',
            type: 'editForm',
            title: 'Reminder configuration',
            collection: SETTINGS_COLLECTION,
            settings: {},
            fields: [
              'enabled',
              'enabledIntervals',
              'emailSubject',
              'emailBody',
            ],
            actions: ['submit'],
          },
          {
            key: 'reminders',
            type: 'table',
            title: 'Reminder log',
            collection: REMINDERS_COLLECTION,
            settings: { pageSize: 20, sorting: [{ field: 'scheduledFor', direction: 'desc' }] },
            fields: [
              { field: 'appointment.calendarTitle', settings: { label: 'Appointment' } },
              { field: 'customer.firstName', settings: { label: 'Customer' } },
              'intervalKey',
              'scheduledFor',
              'status',
              'sentAt',
              'error',
            ],
            actions: ['filter', 'refresh'],
            recordActions: [
              {
                type: 'view',
                settings: { title: 'View' },
                popup: {
                  title: 'Reminder details',
                  tryTemplate: false,
                  blocks: [
                    {
                      key: 'details',
                      type: 'details',
                      title: 'Reminder',
                      resource: { binding: 'currentRecord', collectionName: REMINDERS_COLLECTION },
                      fields: [
                        { field: 'appointment.calendarTitle', settings: { label: 'Appointment' } },
                        { field: 'customer.firstName', settings: { label: 'Customer' } },
                        'intervalKey',
                        'scheduledFor',
                        'status',
                        'sentAt',
                        'error',
                      ],
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

module.exports = {
  DEFAULT_EMAIL_BODY,
  DEFAULT_EMAIL_SUBJECT,
  INTERVALS,
  PROCESS_WORKFLOW_TITLE,
  REMINDER_STATUSES,
  REMINDERS_COLLECTION,
  REMINDERS_PAGE_TITLE,
  SETTINGS_COLLECTION,
  SETTINGS_PAGE_TITLE,
  markDueRemindersSentSql,
  processWorkflowDefinition,
  processWorkflowNodes,
  queueDueRemindersSql,
  remindersCollectionDefinition,
  settingsCollectionDefinition,
  settingsPageBlueprint,
};
