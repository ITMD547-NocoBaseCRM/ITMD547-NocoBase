import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'staffAvailabilityLeaves',
  title: 'Staff leave',
  filterTargetKey: 'id',
  fields: [
    { type: 'bigInt', name: 'staffId', allowNull: false, index: true },
    { type: 'datetimeTz', name: 'startTime', allowNull: false, index: true },
    { type: 'datetimeTz', name: 'endTime', allowNull: false, index: true },
    { type: 'string', name: 'reason' },
  ],
});
