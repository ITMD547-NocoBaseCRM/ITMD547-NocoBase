// US-26 / T-42: declarative blueprint for the Appointments management page.
//
// The page is authored through NocoBase's own flow-surfaces `applyBlueprint` action (the same
// backend the UI builder uses), so no custom API or React code is needed: the table, popups,
// forms and actions all run on the standard `appointments` resource with ACL applied server-side.
//
// Kept as a pure builder so it can be unit-tested and re-applied to any environment with
// `yarn apply:appointments-ui`.
//
// Note: the blueprint authors the toolbar and the table side by side because the authoring validator
// rejects a one-block-per-row layout. `apply-appointments-ui.js` stacks them afterwards with
// `flowSurfaces:setLayout` (see appointments-page-layout.js).

const fs = require('fs');
const path = require('path');
const { REQUIRED_FIELDS } = require('./appointments-schema');

const PAGE_SCHEMA_UID = '7rbhpfmdhv5'; // "Appointments" page under the Salon Management menu group
const TOOLBAR_SCRIPT_PATH = path.join(__dirname, 'ui', 'appointments-toolbar.js');

// Fields the create/edit forms must mark required (DB NOT NULL columns from T-40).
const REQUIRED_FORM_FIELDS = ['customer', 'category', 'appointmentDate', 'startTime', 'status'];

const DELETE_CONFIRM = {
  enable: true,
  title: 'Delete appointment',
  content: 'This appointment and its booked services will be permanently deleted. Continue?',
};

// Form grid: [field key, column span] per row. The booked-services sub-table needs the full width;
// in a half-width cell its price and duration columns are clipped.
const FORM_LAYOUT_ROWS = [
  [
    ['customer', 12],
    ['category', 12],
  ],
  [
    ['staff', 12],
    ['status', 12],
  ],
  [
    ['appointmentDate', 8],
    ['startTime', 8],
    ['endTime', 8],
  ],
  [['appointmentServices', 24]],
  [['notes', 24]],
];

function formFields() {
  const required = (field, extra = {}) => ({ key: field, field, settings: { required: true }, ...extra });
  return [
    required('customer', { titleField: 'firstName' }),
    required('category'),
    {
      key: 'appointmentServices',
      field: 'appointmentServices',
      titleField: 'priceAtBooking',
      settings: {
        fieldType: 'subTable',
        titleField: 'priceAtBooking',
        fields: ['service', 'priceAtBooking', 'durationAtBooking', 'notes'],
      },
    },
    { key: 'staff', field: 'staff', titleField: 'firstName' },
    required('appointmentDate'),
    required('startTime'),
    { key: 'endTime', field: 'endTime' },
    required('status'),
    { key: 'notes', field: 'notes' },
  ];
}

function formLayout() {
  return { rows: FORM_LAYOUT_ROWS.map((row) => row.map(([key, span]) => ({ key, span }))) };
}

function bookedServicesTable(title) {
  return {
    key: 'services',
    type: 'table',
    title,
    resource: {
      binding: 'associatedRecords',
      associationField: 'appointmentServices',
      collectionName: 'appointmentServices',
    },
    fields: ['service.name', 'priceAtBooking', 'durationAtBooking', 'notes'],
    actions: ['refresh'],
    recordActions: [],
  };
}

function editPopup(key) {
  return {
    title: 'Edit appointment',
    tryTemplate: false,
    blocks: [{ key, type: 'editForm', fields: formFields(), fieldsLayout: formLayout(), actions: ['submit'] }],
  };
}

function readToolbarScript() {
  return fs.readFileSync(TOOLBAR_SCRIPT_PATH, 'utf8');
}

function buildAppointmentsPageBlueprint({ pageSchemaUid = PAGE_SCHEMA_UID, toolbarCode = readToolbarScript() } = {}) {
  return {
    version: '1',
    mode: 'replace',
    target: { pageSchemaUid },
    page: { title: 'Appointments', documentTitle: 'Appointments', displayTitle: true, enableTabs: false },
    defaults: {
      collections: {
        appointments: {
          popups: {
            view: { name: 'Appointment details', description: 'View one appointment with its booked services.' },
            addNew: { name: 'New appointment', description: 'Book one appointment.' },
            edit: { name: 'Edit appointment', description: 'Edit one appointment.' },
          },
        },
        appointmentServices: {
          popups: {
            view: { name: 'Booked service', description: 'View one booked service line.' },
            addNew: { name: 'Add booked service', description: 'Add one service line to the appointment.' },
            edit: { name: 'Edit booked service', description: 'Edit one booked service line.' },
          },
        },
      },
    },
    assets: { scripts: { toolbar: { code: toolbarCode } } },
    tabs: [
      {
        key: 'main',
        title: 'Appointments',
        layout: {
          rows: [
            [
              { key: 'toolbar', span: 24 },
              { key: 'appointmentsTable', span: 24 },
            ],
          ],
        },
        blocks: [
          { key: 'toolbar', type: 'jsBlock', title: 'Appointments overview', script: 'toolbar' },
          {
            key: 'appointmentsTable',
            type: 'table',
            title: 'Appointments',
            collection: 'appointments',
            settings: {
              pageSize: 20,
              sorting: [
                { field: 'appointmentDate', direction: 'desc' },
                { field: 'startTime', direction: 'desc' },
              ],
            },
            fields: [
              'appointmentDate',
              'startTime',
              'endTime',
              { field: 'customer.firstName', settings: { label: 'Customer' } },
              { field: 'customer.phone', settings: { label: 'Phone' } },
              { field: 'staff.firstName', settings: { label: 'Technician' } },
              'category',
              'status',
              { field: 'appointmentServices.service.name', settings: { label: 'Services' } },
              'notes',
            ],
            actions: [
              'filter',
              'refresh',
              {
                type: 'addNew',
                settings: { title: 'New appointment', type: 'primary' },
                popup: {
                  title: 'New appointment',
                  tryTemplate: false,
                  blocks: [
                    {
                      key: 'createAppointment',
                      type: 'createForm',
                      collection: 'appointments',
                      fields: formFields(),
                      fieldsLayout: formLayout(),
                      actions: ['submit'],
                    },
                  ],
                },
              },
              'bulkDelete',
            ],
            recordActions: [
              {
                type: 'view',
                settings: { title: 'View' },
                popup: {
                  title: 'Appointment details',
                  tryTemplate: false,
                  layout: {
                    rows: [
                      [
                        { key: 'details', span: 24 },
                        { key: 'services', span: 24 },
                      ],
                    ],
                  },
                  blocks: [
                    {
                      key: 'details',
                      type: 'details',
                      title: 'Appointment',
                      resource: { binding: 'currentRecord', collectionName: 'appointments' },
                      fields: [
                        { field: 'customer.firstName', settings: { label: 'Customer' } },
                        { field: 'customer.phone', settings: { label: 'Phone' } },
                        { field: 'staff.firstName', settings: { label: 'Technician' } },
                        'category',
                        'status',
                        'appointmentDate',
                        'startTime',
                        'endTime',
                        'notes',
                        'createdAt',
                        'updatedAt',
                      ],
                      recordActions: [
                        { type: 'edit', settings: { title: 'Edit' }, popup: editPopup('editFromDetails') },
                      ],
                    },
                    bookedServicesTable('Booked services'),
                  ],
                },
              },
              { type: 'edit', settings: { title: 'Edit' }, popup: editPopup('editAppointment') },
              { type: 'delete', settings: { title: 'Delete', confirm: DELETE_CONFIRM } },
            ],
          },
        ],
      },
    ],
  };
}

module.exports = {
  DELETE_CONFIRM,
  PAGE_SCHEMA_UID,
  REQUIRED_FORM_FIELDS,
  REQUIRED_FIELDS,
  TOOLBAR_SCRIPT_PATH,
  buildAppointmentsPageBlueprint,
  formFields,
  formLayout,
  readToolbarScript,
};
