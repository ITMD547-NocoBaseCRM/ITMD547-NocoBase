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

export default defineCollection({
  name: 'staffAvailabilitySchedules',
  title: 'Staff schedules',
  filterTargetKey: 'id',
  fields: [
    // The staff collection is configured dynamically by this application and
    // loads after static plugin collections, so this must remain a scalar key.
    { type: 'bigInt', name: 'staffId', allowNull: false, index: true },
    { type: 'integer', name: 'weekday', allowNull: false, index: true },
    { type: 'dateOnly', name: 'effectiveFrom', allowNull: false, index: true },
    { type: 'dateOnly', name: 'effectiveTo' },
    { type: 'boolean', name: 'isWorking', defaultValue: true, allowNull: false },
    { type: 'jsonb', name: 'periods', defaultValue: [], uiSchema: periodSchema },
    { type: 'string', name: 'notes' },
  ],
});
