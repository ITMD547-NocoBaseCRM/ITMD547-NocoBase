// Customer messaging: pure definitions of what is applied to NocoBase (unit-tested; no network here).
//
// A merchant selects customers on the Customers page (or takes everyone in the current filter), presses
// "Send message", chooses SMS, Email or both, writes the text and sends. Each recipient and channel becomes one row
// in the `customerMessages` collection (the outbox and the history), status "queued". The workflow
// "Deliver customer messages" fires on each new row and delivers it:
//   * email  -> NocoBase notification channel EMAIL_CHANNEL_NAME (Settings → Notification management → Channels,
//               type Email, SMTP). Create the channel with exactly that name; until it exists, email rows stay queued.
//   * sms    -> an HTTP POST to SMS_WEBHOOK_URL (the salon's SMS gateway: Twilio Functions, a Zapier/Make hook, ...)
//               with { to, body, customerId, messageId } as JSON. Until a real URL is configured, SMS rows fail with
//               a clear error in the workflow execution log and stay queued.
// After a successful send the row is marked "sent" with a timestamp.
//
// `yarn apply:customer-messaging` creates the collection, the workflow and the Customer messages page, and refreshes
// the Customers toolbar (the Send message button lives there: scripts/ui/customers-toolbar.js).

const MESSAGES_COLLECTION = 'customerMessages';
const EMAIL_CHANNEL_NAME = 'customer-email';
const DELIVERY_WORKFLOW_TITLE = 'Deliver customer messages';
const MESSAGES_PAGE_TITLE = 'Customer messages';
const SMS_WEBHOOK_PLACEHOLDER = 'https://sms-gateway.example.invalid/send';

const CHANNELS = [
  { value: 'sms', label: 'SMS', color: 'blue' },
  { value: 'email', label: 'Email', color: 'purple' },
];
const STATUSES = [
  { value: 'queued', label: 'Queued', color: 'gold' },
  { value: 'sent', label: 'Sent', color: 'green' },
  { value: 'failed', label: 'Failed', color: 'red' },
];

const select = (name, title, options, extra = {}) => ({
  name,
  type: 'string',
  interface: 'select',
  enum: options,
  uiSchema: { type: 'string', title, 'x-component': 'Select', enum: options },
  ...extra,
});
const text = (name, title, component = 'Input') => ({ name, type: component === 'Input' ? 'string' : 'text', interface: component === 'Input' ? 'input' : 'textarea', uiSchema: { type: 'string', title, 'x-component': component === 'Input' ? 'Input' : 'Input.TextArea' } });
const datetime = (name, title) => ({ name, type: 'date', interface: 'datetime', uiSchema: { type: 'string', title, 'x-component': 'DatePicker', 'x-component-props': { showTime: true, utc: true }, 'x-read-pretty': true } });

// collections:create does not add the bookkeeping fields' metadata on its own, so they are declared explicitly
// (same shapes as on the other collections).
const userRef = (name, title, foreignKey) => ({
  name,
  type: 'belongsTo',
  interface: name,
  target: 'users',
  foreignKey,
  targetKey: 'id',
  uiSchema: { type: 'object', title, 'x-component': 'AssociationField', 'x-component-props': { fieldNames: { value: 'id', label: 'nickname' } }, 'x-read-pretty': true },
});
const stamp = (name, title) => ({ name, type: 'date', interface: name, field: name, uiSchema: { type: 'datetime', title, 'x-component': 'DatePicker', 'x-read-pretty': true } });
function systemFields() {
  return [stamp('createdAt', 'Created at'), userRef('createdBy', 'Created by', 'createdById'), stamp('updatedAt', 'Last updated at'), userRef('updatedBy', 'Last updated by', 'updatedById')];
}

function messagesCollectionDefinition() {
  return {
    name: MESSAGES_COLLECTION,
    title: MESSAGES_PAGE_TITLE,
    template: 'general',
    logging: true,
    createdBy: true,
    updatedBy: true,
    createdAt: true,
    updatedAt: true,
    titleField: 'subject',
    description: 'Outbox and history of SMS and email messages sent to customers from the Customers page. One row per recipient and channel.',
    fields: [
      {
        name: 'customer',
        type: 'belongsTo',
        interface: 'm2o',
        target: 'customers',
        foreignKey: 'customerId',
        targetKey: 'id',
        uiSchema: { type: 'object', title: 'Customer', 'x-component': 'AssociationField', 'x-component-props': { multiple: false, fieldNames: { value: 'id', label: 'firstName' } } },
      },
      select('channel', 'Channel', CHANNELS),
      text('recipient', 'Recipient'),
      text('subject', 'Subject'),
      text('body', 'Message', 'TextArea'),
      { name: 'bodyHtml', type: 'text', interface: 'textarea', uiSchema: { type: 'string', title: 'Message (HTML, email)', 'x-component': 'Input.TextArea' } },
      select('status', 'Status', STATUSES, { defaultValue: 'queued' }),
      datetime('sentAt', 'Sent at'),
      text('error', 'Error', 'TextArea'),
      text('batchKey', 'Batch'),
      ...systemFields(),
    ],
  };
}

// Variables available to the workflow nodes: {{$context.data.<field>}} is the new customerMessages row.
const v = (field) => `{{$context.data.${field}}}`;

function deliveryWorkflowDefinition() {
  return {
    title: DELIVERY_WORKFLOW_TITLE,
    type: 'collection',
    enabled: true,
    description: `Delivers each new customerMessages row: email through the notification channel "${EMAIL_CHANNEL_NAME}", SMS through an HTTP POST to the SMS gateway. Marks the row sent on success. Created by yarn apply:customer-messaging.`,
    config: { collection: MESSAGES_COLLECTION, mode: 1, appends: ['customer'] },
  };
}

const equals = (field, value) => ({
  rejectOnFalse: false,
  engine: 'basic',
  calculation: { group: { type: 'and', calculations: [{ calculator: 'equal', operands: [v(field), value] }] } },
});
const markSent = (title) => ({
  type: 'update',
  title,
  config: {
    collection: MESSAGES_COLLECTION,
    params: { filter: { id: { $eq: v('id') } }, values: { status: 'sent', sentAt: '{{$system.now}}', error: null } },
  },
});

// The SMS request node. Two providers:
//   * twilio  -> POST https://api.twilio.com/2010-04-01/Accounts/<SID>/Messages.json (form-encoded To/From/Body,
//                HTTP Basic auth with the account SID and auth token). Recipients must be E.164 (+13125551234);
//                the toolbar normalises phones before queuing.
//   * webhook -> POST JSON { to, body, customerId, messageId } to any URL (a relay in front of another provider).
function smsNodeConfig({ smsProvider, twilio, smsWebhookUrl = SMS_WEBHOOK_PLACEHOLDER, smsAuthHeader = '' }) {
  if (smsProvider === 'twilio') {
    const { accountSid, authToken, from } = twilio || {};
    if (!accountSid || !authToken || !from) throw new Error('Twilio needs accountSid, authToken and from');
    return {
      url: `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      method: 'POST',
      contentType: 'application/x-www-form-urlencoded',
      headers: [{ name: 'Authorization', value: 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64') }],
      params: [],
      data: [{ name: 'To', value: v('recipient') }, { name: 'From', value: from }, { name: 'Body', value: v('body') }],
      timeout: 15000,
      ignoreFail: false,
    };
  }
  return {
    url: smsWebhookUrl,
    method: 'POST',
    contentType: 'application/json',
    headers: smsAuthHeader ? [{ name: 'Authorization', value: smsAuthHeader }] : [],
    params: [],
    data: { to: v('recipient'), body: v('body'), customerId: v('customerId'), messageId: v('id') },
    timeout: 10000,
    ignoreFail: false,
  };
}

// Node chain. `key` is only used to wire upstream/branch references in the apply script.
// emailChannelName is the channel's internal name (NocoBase generates one like "s_eze7ih9g9fo" when a channel is
// created in the UI; the title is only a label). The apply script resolves it from the configured email channels.
function deliveryWorkflowNodes({ smsProvider = 'webhook', twilio, smsWebhookUrl = SMS_WEBHOOK_PLACEHOLDER, smsAuthHeader = '', emailChannelName = EMAIL_CHANNEL_NAME } = {}) {
  return [
    { key: 'isEmail', type: 'condition', title: 'Email?', config: equals('channel', 'email') },
    {
      key: 'sendEmail', upstream: 'isEmail', branch: 1,
      type: 'notification', title: 'Send email',
      // Emails are HTML (the dialog's rich editor: formatting, links, inline images). bodyHtml always carries at least
      // the plain text wrapped in a paragraph, so an email never goes out empty.
      config: { channelName: emailChannelName, to: [v('recipient')], subject: v('subject'), contentType: 'html', html: v('bodyHtml'), ignoreFail: false },
    },
    { key: 'emailSent', upstream: 'sendEmail', ...markSent('Mark email sent') },
    { key: 'isSms', upstream: 'isEmail', type: 'condition', title: 'SMS?', config: equals('channel', 'sms') },
    {
      key: 'sendSms', upstream: 'isSms', branch: 1,
      type: 'request', title: 'Send SMS (HTTP POST to the gateway)',
      config: smsNodeConfig({ smsProvider, twilio, smsWebhookUrl, smsAuthHeader }),
    },
    { key: 'smsSent', upstream: 'sendSms', ...markSent('Mark SMS sent') },
  ];
}

// The Customer messages page: a table of the outbox, newest first.
function messagesPageBlueprint({ pageSchemaUid }) {
  return {
    version: '1',
    mode: 'replace',
    target: { pageSchemaUid },
    page: { title: MESSAGES_PAGE_TITLE, documentTitle: MESSAGES_PAGE_TITLE, displayTitle: true, enableTabs: false },
    tabs: [
      {
        key: 'main',
        title: MESSAGES_PAGE_TITLE,
        layout: { rows: [[{ key: 'messages', span: 24 }]] },
        blocks: [
          {
            key: 'messages',
            type: 'table',
            title: MESSAGES_PAGE_TITLE,
            collection: MESSAGES_COLLECTION,
            settings: { pageSize: 20, sorting: [{ field: 'createdAt', direction: 'desc' }] },
            fields: [
              'createdAt',
              { field: 'customer.firstName', settings: { label: 'Customer' } },
              'channel',
              'recipient',
              'subject',
              'body',
              'status',
              'sentAt',
              'error',
              { field: 'createdBy.nickname', settings: { label: 'Sent by' } },
            ],
            actions: ['filter', 'refresh'],
            recordActions: [
              {
                type: 'view',
                settings: { title: 'View' },
                popup: {
                  title: 'Message',
                  tryTemplate: false,
                  blocks: [
                    {
                      key: 'details',
                      type: 'details',
                      title: 'Message',
                      resource: { binding: 'currentRecord', collectionName: MESSAGES_COLLECTION },
                      fields: [{ field: 'customer.firstName', settings: { label: 'Customer' } }, 'channel', 'recipient', 'subject', 'body', 'status', 'sentAt', 'error', 'createdAt', { field: 'createdBy.nickname', settings: { label: 'Sent by' } }],
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

// Wraps the editor's HTML in a minimal, mail-client-safe envelope (same function in the toolbar).
function emailEnvelope(innerHtml) {
  return '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#111827;max-width:640px">' + innerHtml + '</div>';
}

// Renders {{firstName}} / {{lastName}} / {{fullName}} in a message for one customer (same rule in the toolbar).
function renderTemplate(template, customer) {
  const values = {
    firstName: customer.firstName || '',
    lastName: customer.lastName || '',
    fullName: [customer.firstName, customer.lastName].filter(Boolean).join(' '),
  };
  return String(template || '').replace(/\{\{\s*(firstName|lastName|fullName)\s*\}\}/g, (_, key) => values[key]);
}

module.exports = {
  CHANNELS,
  DELIVERY_WORKFLOW_TITLE,
  EMAIL_CHANNEL_NAME,
  MESSAGES_COLLECTION,
  MESSAGES_PAGE_TITLE,
  SMS_WEBHOOK_PLACEHOLDER,
  STATUSES,
  deliveryWorkflowDefinition,
  deliveryWorkflowNodes,
  emailEnvelope,
  messagesCollectionDefinition,
  messagesPageBlueprint,
  renderTemplate,
  smsNodeConfig,
  systemFields,
};
