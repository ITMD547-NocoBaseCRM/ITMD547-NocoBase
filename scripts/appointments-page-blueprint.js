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
const { CATEGORY_TABS, REQUIRED_FIELDS, getCategoryFilter } = require('./appointments-schema');

const PAGE_SCHEMA_UID = '7rbhpfmdhv5'; // "Appointments" page under the Salon Management menu group
const TOOLBAR_SCRIPT_PATH = path.join(__dirname, 'ui', 'appointments-toolbar.js');
const SENSITIVITY_SCRIPT_PATH = path.join(__dirname, 'ui', 'appointments-sensitivity.js');

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

// Customer skin sensitivities (US-01) read through the appointment's customer relation and drawn by a JS
// renderer. Binding to the real field path makes the table append the customer relation it already loads, so
// no extra request is made and nothing is copied onto the appointment.
function sensitivityField(script, label = 'Sensitivities') {
  return { key: script, field: 'customer.skinSensitivities', renderer: 'js', script, settings: { label } };
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

// The toolbar script declares its type tabs as `const TABS = /*APPOINTMENT_TABS*/[];`. They are filled in
// from the T-40 schema module so the tab labels and their server-side category filters have one source.
const TABS_PLACEHOLDER = '/*APPOINTMENT_TABS*/[]';

function toolbarTabs() {
  return CATEGORY_TABS.map(({ key, label, category }) => ({ key, label, category, filter: getCategoryFilter(key) }));
}

function readToolbarScript() {
  const source = fs.readFileSync(TOOLBAR_SCRIPT_PATH, 'utf8');
  if (!source.includes(TABS_PLACEHOLDER)) {
    throw new Error(`${TOOLBAR_SCRIPT_PATH} is missing the ${TABS_PLACEHOLDER} placeholder`);
  }
  // A replacer function keeps "$" sequences in the JSON (for example "$eq") literal.
  return source.replace(TABS_PLACEHOLDER, () => JSON.stringify(toolbarTabs()));
}

// The sensitivity indicator script has two renderings: a compact button for table rows ('cell') and an inline
// list for the details drawer ('details'). The variant literal in the file is filled in here.
const SENSITIVITY_VARIANTS = ['cell', 'details'];
const SENSITIVITY_PLACEHOLDER = "/*SENSITIVITY_VARIANT*/'cell'";

function readSensitivityScript(variant = 'cell') {
  if (!SENSITIVITY_VARIANTS.includes(variant)) throw new Error(`Unknown sensitivity variant: ${variant}`);
  const source = fs.readFileSync(SENSITIVITY_SCRIPT_PATH, 'utf8');
  if (!source.includes(SENSITIVITY_PLACEHOLDER)) {
    throw new Error(`${SENSITIVITY_SCRIPT_PATH} is missing the ${SENSITIVITY_PLACEHOLDER} placeholder`);
  }
  return source.replace(SENSITIVITY_PLACEHOLDER, () => `'${variant}'`);
}

function buildAppointmentsPageBlueprint({
  pageSchemaUid = PAGE_SCHEMA_UID,
  toolbarCode = readToolbarScript(),
  sensitivityCellCode = readSensitivityScript('cell'),
  sensitivityDetailsCode = readSensitivityScript('details'),
} = {}) {
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
    assets: {
      scripts: {
        toolbar: { code: toolbarCode },
        sensitivityCell: { version: 'v2', code: sensitivityCellCode },
        sensitivityDetails: { version: 'v2', code: sensitivityDetailsCode },
      },
    },
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
              sensitivityField('sensitivityCell'),
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
                        sensitivityField('sensitivityDetails', 'Customer skin sensitivities'),
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
  SENSITIVITY_SCRIPT_PATH,
  TOOLBAR_SCRIPT_PATH,
  buildAppointmentsPageBlueprint,
  formFields,
  formLayout,
  readSensitivityScript,
  readToolbarScript,
  sensitivityField,
  toolbarTabs,
};
