// BeautyWithin CRM – role permission spec (docs/rbac.md). Applied by scripts/apply-rbac.js (rbac-core.js).
//
// NOTE: in NocoBase 2.2 an action with an empty field list exposes NO fields (only id and timestamps). In this spec
// `fields: []` means "every field of the collection"; rbac-core expands it from the collection metadata.
//
// Every business role gets an EMPTY data strategy: nothing is readable unless it is listed here. Admin keeps its
// built-in "all collections" strategy and is not changed (root is NocoBase's superuser and is never touched).
// Field lists are allow-lists; [] means every field. Association fields must be listed to be readable/appendable.
// `scope` names a scope in SCOPES (record-level filter).

const ALL = ['create', 'view', 'update', 'destroy', 'export', 'importXlsx'];
const S = '{{$user.staff.id}}';
// Every staff filter also requires the staff id to exist, so an account with no linked staff record matches nothing.
const own = (path) => ({ $and: [{ [path]: { $exists: true } }, { [path]: { $eq: S } }] });
const nested = (assoc, inner) => ({ [assoc]: inner });

const SCOPES = {
  // Existing scopes (kept, matched by name)
  'Assigned to me (staff)': { resourceName: 'appointments', scope: own('staffId') },
  'Own notes (staff technician)': { resourceName: 'customerNotes', scope: own('staffId') },
  'Assigned to me (staff, via appointment)': { resourceName: 'payments', scope: { $and: [nested('appointment', { staffId: { $exists: true } }), nested('appointment', { staffId: { $eq: S } })] } },
  // New scopes
  'RBAC staff: own appointment times': { resourceName: 'appointments_time_view', scope: own('staffId') },
  'RBAC staff: services on own appointments': { resourceName: 'appointmentServices', scope: { $and: [nested('appointment', { staffId: { $exists: true } }), nested('appointment', { staffId: { $eq: S } })] } },
  'RBAC staff: customers of own appointments': { resourceName: 'customers', scope: { $and: [nested('appointments', { staffId: { $exists: true } }), nested('appointments', { staffId: { $eq: S } })] } },
  'RBAC staff: activity of own customers': { resourceName: 'customerActivity', scope: { $and: [nested('customer', { appointments: { staffId: { $exists: true } } }), nested('customer', { appointments: { staffId: { $eq: S } } })] } },
  'RBAC staff: own and own-customer notes': {
    resourceName: 'customerNotes',
    scope: { $or: [own('staffId'), { $and: [{ staffId: { $empty: true } }, nested('customer', { appointments: { staffId: { $exists: true } } }), nested('customer', { appointments: { staffId: { $eq: S } } })] }] },
  },
  'RBAC staff: own shifts': { resourceName: 'employeeShifts', scope: own('staffId') },
  'RBAC staff: own staff record': { resourceName: 'staff', scope: own('id') },
  'RBAC staff: services I perform': { resourceName: 'services', scope: { $and: [nested('staff', { id: { $exists: true } }), nested('staff', { id: { $eq: S } })] } },
  'RBAC staff: own service links': { resourceName: 'staffServices', scope: own('staffId') },
  'RBAC staff: own availability schedule': { resourceName: 'staffAvailabilitySchedules', scope: own('staffId') },
  'RBAC staff: own availability overrides': { resourceName: 'staffAvailabilityOverrides', scope: own('staffId') },
  'RBAC staff: own leave': { resourceName: 'staffAvailabilityLeaves', scope: own('staffId') },
  'RBAC: own saved views': { resourceName: 'customerSavedViews', scope: { createdById: { $eq: '{{$user.id}}' } } },
};

const CUSTOMER_CONSENT = ['emailMarketingOptIn', 'emailTransactionalOptIn', 'smsMarketingOptIn', 'smsTransactionalOptIn',
  'emailMarketingOptInAt', 'emailTransactionalOptInAt', 'smsMarketingOptInAt', 'smsTransactionalOptInAt'];
const CUSTOMER_VISITS = ['visitCount', 'firstVisitAt', 'lastVisitAt', 'visitsLast1m', 'visitsLast2m', 'visitsLast3m', 'visitsLast4m',
  'visitsLast5m', 'visitsLast6m', 'visitsLast12m', 'activityRefreshedAt', 'birthMonthDay'];
const CUSTOMER_MEDICAL = ['skinProfile', 'skinProfileOther', 'skinSensitivities', 'skinSensitivitiesOther'];
const CUSTOMER_CONTACT = ['firstName', 'lastName', 'email', 'phone', 'dateOfBirth', 'address', 'notes', 'status', 'referralSource'];
const AUDIT = ['id', 'createdAt', 'createdBy', 'createdById', 'updatedAt', 'updatedBy', 'updatedById'];

// Receptionist: everything a front desk needs; no spend totals, no payments, consent visible but changed only
// through consent events.
const CUSTOMER_RECEPTION_VIEW = [...AUDIT, ...CUSTOMER_CONTACT, ...CUSTOMER_MEDICAL, ...CUSTOMER_VISITS, ...CUSTOMER_CONSENT,
  'appointments', 'customerMemberships', 'customerNotes', 'activity'];
const CUSTOMER_RECEPTION_EDIT = [...CUSTOMER_CONTACT, ...CUSTOMER_MEDICAL];
// Staff: only what is needed to serve the customer at their own appointments.
const CUSTOMER_STAFF_VIEW = ['id', 'firstName', 'lastName', 'phone', 'status', ...CUSTOMER_MEDICAL, 'visitCount', 'firstVisitAt',
  'lastVisitAt', 'appointments', 'customerNotes', 'activity'];
const ACTIVITY_NO_SPEND = ['id', 'customerId', 'totalVisits', 'firstVisitAt', 'lastVisitAt', 'daysSinceLastVisit', 'visitsLast1m',
  'visitsLast2m', 'visitsLast3m', 'visitsLast4m', 'visitsLast5m', 'visitsLast6m', 'visitsLast12m', 'customer'];
const STAFF_PUBLIC = ['id', 'firstName', 'lastName', 'role', 'specialty', 'active', 'services'];
const USER_PUBLIC = ['id', 'nickname', 'username'];

const a = (name, extra = {}) => ({ name, fields: [], ...extra });
const many = (names, extra) => names.map((n) => a(n, extra));
const ownViews = { customerSavedViews: [a('create'), a('view', { scope: 'RBAC: own saved views' }), a('update', { scope: 'RBAC: own saved views' }), a('destroy', { scope: 'RBAC: own saved views' })] };

const ROLES = {
  manager: {
    title: 'Manager',
    strategy: [],
    // Customer review moderation/invitations. No other settings pages: no workflow, plugins, data sources,
    // API keys, variables, authentication, users & permissions, system settings, UI configuration.
    snippets: ['pm.customer-reviews', '!pm', '!ui.*', '!app'],
    allowConfigure: false,
    allowNewMenu: false,
    collections: {
      ...Object.fromEntries(['customers', 'appointments', 'appointmentServices', 'services', 'serviceCategories', 'staffServices',
        'memberships', 'membershipBenefits', 'customerMemberships', 'payments', 'staff', 'employeeShifts', 'customerNotes',
        'staffAvailabilitySchedules', 'staffAvailabilityOverrides', 'staffAvailabilityLeaves'].map((c) => [c, many(ALL)])),
      appointments_time_view: many(['view', 'export']),
      customerActivity: many(['view', 'export']),
      appointmentReminders: many(['view']),
      appointmentReminderSettings: many(['view', 'update']),
      appointmentAvailabilitySettings: many(['view', 'update']),
      customerMessages: many(['create', 'view', 'export']),
      communication_consent_events: many(['create', 'view', 'export']), // append-only (workflow guard)
      communication_suppressions: many(['create', 'view', 'update']), // never deleted (workflow guard)
      ...ownViews,
      users: [a('view', { fields: [...USER_PUBLIC, 'email', 'staff', 'createdAt', 'updatedAt'] })],
      roles: [a('view', { fields: ['name', 'title', 'description'] })],
    },
    // The whole portal except standalone pages that duplicate a tab and were hidden before:
    // Customer Notes (= Customers → Customer Notes), Message History (= Messages → Message History),
    // Reminder Settings (= Messages → Appointment Reminder).
    menus: {
      include: [['Beauty Within Portal']],
      exclude: [['Beauty Within Portal', 'Customer Notes'], ['Beauty Within Portal', 'Message History'], ['Beauty Within Portal', 'Reminder Settings'],
        ['Beauty Within Portal', 'My Workspace']], // technicians' page (needs a linked employee record)
    },
  },
  receptionist: {
    title: 'Receptionist',
    strategy: [],
    snippets: ['pm.customer-reviews.invitations', '!pm', '!ui.*', '!app'],
    allowConfigure: false,
    allowNewMenu: false,
    collections: {
      customers: [a('create', { fields: CUSTOMER_RECEPTION_EDIT }), a('view', { fields: CUSTOMER_RECEPTION_VIEW }), a('update', { fields: CUSTOMER_RECEPTION_EDIT })],
      appointments: many(['create', 'view', 'update']),
      appointmentServices: many(['create', 'view', 'update', 'destroy']), // booked-service lines of an appointment
      appointments_time_view: many(['view']),
      services: many(['view']),
      serviceCategories: many(['view']),
      staffServices: many(['view']),
      memberships: many(['view']),
      membershipBenefits: many(['view']),
      customerMemberships: many(['create', 'view', 'update']),
      staff: [a('view', { fields: STAFF_PUBLIC })],
      employeeShifts: many(['create', 'view', 'update']),
      staffAvailabilitySchedules: many(['create', 'view', 'update']),
      staffAvailabilityOverrides: many(['create', 'view', 'update']),
      staffAvailabilityLeaves: many(['create', 'view', 'update']),
      appointmentAvailabilitySettings: many(['view']),
      customerNotes: many(['create', 'view', 'update']),
      customerActivity: [a('view', { fields: ACTIVITY_NO_SPEND })],
      communication_consent_events: many(['create', 'view']), // opt-ins need evidence (workflow guard)
      communication_suppressions: many(['view']),
      ...ownViews,
      users: [a('view', { fields: USER_PUBLIC })],
    },
    menus: {
      include: [
        ['Beauty Within Portal', 'Dashboard'],
        ['Beauty Within Portal', 'Customers'],
        ['Beauty Within Portal', 'Appointments'],
        ['Beauty Within Portal', 'Appointment services'],
        ['Beauty Within Portal', 'Shifts'],
        ['Beauty Within Portal', 'Services'],
        ['Beauty Within Portal', 'Service Categories'],
        ['Beauty Within Portal', 'Memberships'],
        ['Beauty Within Portal', 'Customer Memberships'],
        ['Beauty Within Portal', 'Membership Benefits'],
      ],
    },
  },
  staff: {
    title: 'Staff',
    strategy: [],
    snippets: ['!pm', '!ui.*', '!app'],
    allowConfigure: false,
    allowNewMenu: false,
    collections: {
      appointments: [
        a('create'), // booking is limited to themselves by the "Staff can only book their own appointments" workflow
        a('view', { scope: 'Assigned to me (staff)' }),
        a('update', { scope: 'Assigned to me (staff)', fields: ['status', 'notes'] }),
      ],
      appointments_time_view: [a('view', { scope: 'RBAC staff: own appointment times' })],
      appointmentServices: [a('view', { scope: 'RBAC staff: services on own appointments' })],
      // Own performance only (Statistics → Staff Performance): amounts of payments on their own appointments.
      payments: [a('view', { scope: 'Assigned to me (staff, via appointment)', fields: ['id', 'appointmentId', 'amount', 'paymentDate', 'paymentType', 'status', 'appointment', 'createdAt'] })],
      customers: [a('view', { scope: 'RBAC staff: customers of own appointments', fields: CUSTOMER_STAFF_VIEW })],
      customerActivity: [a('view', { scope: 'RBAC staff: activity of own customers', fields: ACTIVITY_NO_SPEND })],
      customerNotes: [
        a('create', { fields: ['customer', 'customerId', 'staff', 'staffId', 'note'] }), // owner forced by workflow
        a('view', { scope: 'RBAC staff: own and own-customer notes' }),
        a('update', { scope: 'Own notes (staff technician)', fields: ['note'] }),
      ],
      employeeShifts: [a('view', { scope: 'RBAC staff: own shifts' })],
      staff: [a('view', { scope: 'RBAC staff: own staff record', fields: [...STAFF_PUBLIC, 'email', 'phone', 'shifts'] })],
      services: [a('view', { scope: 'RBAC staff: services I perform' })],
      serviceCategories: many(['view']),
      staffServices: [a('view', { scope: 'RBAC staff: own service links' })],
      staffAvailabilitySchedules: [a('view', { scope: 'RBAC staff: own availability schedule' })],
      staffAvailabilityOverrides: [a('view', { scope: 'RBAC staff: own availability overrides' })],
      staffAvailabilityLeaves: [a('view', { scope: 'RBAC staff: own leave' })],
      appointmentAvailabilitySettings: many(['view']),
      ...ownViews,
      users: [a('view', { fields: USER_PUBLIC })],
    },
    menus: {
      include: [
        ['Beauty Within Portal', 'My Workspace'],
        ['Beauty Within Portal', 'Dashboard'],
        ['Beauty Within Portal', 'Appointments'],
        ['Beauty Within Portal', 'Shifts'],
        ['Beauty Within Portal', 'Customers', 'Customers List'],
        ['Beauty Within Portal', 'Customers', 'Customer Notes'],
        ['Beauty Within Portal', 'Services', 'Service List'],
        ['Beauty Within Portal', 'Statistics', 'Staff Performance'],
      ],
    },
  },
  member: {
    title: 'Member',
    strategy: [],
    snippets: ['!pm', '!pm.*', '!ui.*', '!app'],
    allowConfigure: false,
    allowNewMenu: false,
    collections: {},
    menus: { include: [['Access Pending']] },
  },
};

// Fields of plugin-defined collections that collections:listMeta does not report (used to expand `fields: []`).
const PLUGIN_FIELDS = {
  staffAvailabilitySchedules: ['id', 'staffId', 'weekday', 'effectiveFrom', 'effectiveTo', 'isWorking', 'periods', 'notes', 'createdAt', 'updatedAt'],
  staffAvailabilityOverrides: ['id', 'staffId', 'date', 'isWorking', 'periods', 'reason', 'createdAt', 'updatedAt'],
  staffAvailabilityLeaves: ['id', 'staffId', 'startTime', 'endTime', 'reason', 'createdAt', 'updatedAt'],
  appointmentAvailabilitySettings: ['id', 'timeZone', 'slotIntervalMinutes', 'defaultDurationMinutes', 'createdAt', 'updatedAt'],
};

// Collections a role had configured before but no longer lists are set to "no actions".
const ACCESS_PENDING = {
  title: 'Access Pending',
  icon: 'LockOutlined',
};

// Two-level related-field paths used by the custom JS blocks (dashboard), added to "all fields" lists.
const EXTRA_PATHS = {
  appointments: ['appointmentServices.service.name', 'appointmentServices.service.price'],
};

module.exports = { ROLES, SCOPES, ACCESS_PENDING, PLUGIN_FIELDS, EXTRA_PATHS };
