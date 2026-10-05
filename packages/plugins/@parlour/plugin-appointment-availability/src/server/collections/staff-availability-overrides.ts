import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'staffAvailabilityOverrides',
  title: 'Staff schedule overrides',
  filterTargetKey: 'id',
  fields: [
    { type: 'bigInt', name: 'staffId', allowNull: false, index: true },
    { type: 'dateOnly', name: 'date', allowNull: false, index: true },
    { type: 'boolean', name: 'isWorking', defaultValue: false, allowNull: false },
    { type: 'jsonb', name: 'periods', defaultValue: [] },
    { type: 'string', name: 'reason' },
  ],
});
