import { defineCollection } from '@nocobase/database';
import { DELIVERIES, INVITATIONS } from '../../constants';

/**
 * Delivery outbox: one row per review-invitation email (one email can carry several technicians' links).
 *
 * The row is written and committed before the email is handed to SMTP, so a crash or timeout leaves a durable
 * record (status `sending` with an expired lock) that staff can see and retry. `idempotencyKey` is unique: the
 * same completion event (workflow execution) can never create a second delivery.
 *
 * Status: pending -> sending -> sent | failed; or skipped (policy said no; nothing created or sent).
 * `sent` means the SMTP server accepted the message. It is not proof of inbox delivery.
 */
export default defineCollection({
  name: DELIVERIES,
  title: 'Customer review deliveries',
  filterTargetKey: 'id',
  autoGenId: false,
  timestamps: true,
  fields: [
    { type: 'snowflakeId', name: 'id', primaryKey: true, allowNull: false },
    { type: 'bigInt', name: 'appointmentId', allowNull: false, index: true },
    { type: 'bigInt', name: 'customerId' },
    { type: 'string', name: 'idempotencyKey', allowNull: false, unique: true },
    // workflow | manual | retry | resend | regenerate
    { type: 'string', name: 'trigger', allowNull: false, defaultValue: 'workflow' },
    { type: 'string', name: 'status', allowNull: false, defaultValue: 'pending' },
    { type: 'string', name: 'skipReason' },
    { type: 'string', name: 'skipMessage' },
    { type: 'integer', name: 'invitationCount', allowNull: false, defaultValue: 0 },
    { type: 'integer', name: 'attempts', allowNull: false, defaultValue: 0 },
    { type: 'datetimeTz', name: 'lockedUntil' },
    { type: 'datetimeTz', name: 'sentAt' },
    { type: 'text', name: 'lastError' },
    { type: 'string', name: 'messageId' },
    { type: 'bigInt', name: 'createdById' },
    { type: 'belongsTo', name: 'createdBy', target: 'users', foreignKey: 'createdById', constraints: false },
    { type: 'hasMany', name: 'invitations', target: INVITATIONS, foreignKey: 'deliveryId', constraints: false },
  ],
});
