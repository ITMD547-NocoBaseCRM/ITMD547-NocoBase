import { defineCollection } from '@nocobase/database';
import { DELIVERIES, INVITATIONS, REVIEWS } from '../../constants';

/**
 * A single-use review link for one technician of one appointment.
 *
 * Only `tokenHash` (HMAC-SHA256) is stored, never the token. `activeKey` is `<appointmentId>:<staffId>` while the
 * invitation is unused and not revoked, and NULL afterwards; its unique index guarantees at most one active
 * invitation per appointment and technician on every database dialect.
 */
export default defineCollection({
  name: INVITATIONS,
  title: 'Customer review invitations',
  filterTargetKey: 'id',
  autoGenId: false,
  timestamps: true,
  fields: [
    { type: 'snowflakeId', name: 'id', primaryKey: true, allowNull: false },
    { type: 'bigInt', name: 'appointmentId', allowNull: false },
    { type: 'bigInt', name: 'customerId', allowNull: false, index: true },
    { type: 'bigInt', name: 'staffId', allowNull: false },
    { type: 'string', name: 'tokenHash', allowNull: false, unique: true, hidden: true },
    { type: 'string', name: 'activeKey', unique: true },
    { type: 'datetimeTz', name: 'expiresAt', allowNull: false },
    { type: 'datetimeTz', name: 'usedAt' },
    { type: 'datetimeTz', name: 'revokedAt' },
    { type: 'string', name: 'revokedReason' },
    // email | manual (a link created by staff to hand over in person; nothing is sent)
    { type: 'string', name: 'channel', allowNull: false, defaultValue: 'email' },
    // pending | sent | failed | skipped
    { type: 'string', name: 'deliveryStatus', allowNull: false, defaultValue: 'pending' },
    { type: 'datetimeTz', name: 'sentAt' },
    { type: 'integer', name: 'sendAttempts', allowNull: false, defaultValue: 0 },
    { type: 'text', name: 'lastSendError' },
    { type: 'bigInt', name: 'deliveryId', index: true },
    // NULL = created by the system (the review workflow).
    { type: 'bigInt', name: 'createdById' },
    { type: 'belongsTo', name: 'createdBy', target: 'users', foreignKey: 'createdById', constraints: false },
    { type: 'belongsTo', name: 'delivery', target: DELIVERIES, foreignKey: 'deliveryId', constraints: false },
    { type: 'hasOne', name: 'review', target: REVIEWS, foreignKey: 'invitationId', constraints: false },
  ],
  indexes: [{ fields: ['appointmentId', 'staffId'], name: 'customer_review_invitations_appointment_staff' }],
});
