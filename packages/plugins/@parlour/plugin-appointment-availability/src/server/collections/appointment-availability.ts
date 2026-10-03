import { defineCollection } from '@nocobase/database';

const periodSchema = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      start: { type: 'string' },
      end: { type: 'string' },
    },
    required: ['start', 'end'],
  },
};

export const scheduleCollection = defineCollection({
  name: 'staffAvailabilitySchedules',
  title: 'Staff schedules',
  filterTargetKey: 'id',
  fields: [
    { type: 'belongsTo', name: 'staff', target: 'staff', foreignKey: 'staffId', allowNull: false, index: true },
    { type: 'integer', name: 'weekday', allowNull: false, index: true },
    { type: 'dateOnly', name: 'effectiveFrom', allowNull: false, index: true },
    { type: 'dateOnly', name: 'effectiveTo' },
    { type: 'boolean', name: 'isWorking', defaultValue: true, allowNull: false },
    { type: 'jsonb', name: 'periods', defaultValue: [], uiSchema: periodSchema },
    { type: 'string', name: 'notes' },
  ],
});

export const overrideCollection = defineCollection({
  name: 'staffAvailabilityOverrides',
  title: 'Staff schedule overrides',
  filterTargetKey: 'id',
  fields: [
    { type: 'belongsTo', name: 'staff', target: 'staff', foreignKey: 'staffId', allowNull: false, index: true },
    { type: 'dateOnly', name: 'date', allowNull: false, index: true },
    { type: 'boolean', name: 'isWorking', defaultValue: false, allowNull: false },
    { type: 'jsonb', name: 'periods', defaultValue: [], uiSchema: periodSchema },
    { type: 'string', name: 'reason' },
  ],
});

export const leaveCollection = defineCollection({
  name: 'staffAvailabilityLeaves',
  title: 'Staff leave',
  filterTargetKey: 'id',
  fields: [
    { type: 'belongsTo', name: 'staff', target: 'staff', foreignKey: 'staffId', allowNull: false, index: true },
    { type: 'datetimeTz', name: 'startTime', allowNull: false, index: true },
    { type: 'datetimeTz', name: 'endTime', allowNull: false, index: true },
    { type: 'string', name: 'reason' },
  ],
});

export const settingsCollection = defineCollection({
  name: 'appointmentAvailabilitySettings',
  title: 'Appointment availability settings',
  filterTargetKey: 'id',
  fields: [
    { type: 'string', name: 'timeZone', defaultValue: 'America/Chicago', allowNull: false },
    { type: 'integer', name: 'slotIntervalMinutes', defaultValue: 15, allowNull: false },
    { type: 'integer', name: 'defaultDurationMinutes', defaultValue: 60, allowNull: false },
  ],
});
