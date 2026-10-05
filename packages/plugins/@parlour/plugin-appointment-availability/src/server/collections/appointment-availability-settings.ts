import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'appointmentAvailabilitySettings',
  title: 'Appointment availability settings',
  filterTargetKey: 'id',
  fields: [
    { type: 'string', name: 'timeZone', defaultValue: 'America/Chicago', allowNull: false },
    { type: 'integer', name: 'slotIntervalMinutes', defaultValue: 15, allowNull: false },
    { type: 'integer', name: 'defaultDurationMinutes', defaultValue: 60, allowNull: false },
  ],
});
