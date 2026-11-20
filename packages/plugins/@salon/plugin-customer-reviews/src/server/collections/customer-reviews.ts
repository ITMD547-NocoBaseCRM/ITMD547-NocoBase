import { defineCollection } from '@nocobase/database';
import { INVITATIONS, MODERATION_EVENTS, REVIEWS } from '../../constants';

/**
 * One customer review of one technician for one appointment.
 *
 * Rows are created only by the public submission action (never through the generic create API), and the
 * customer's rating and comment are immutable: moderation changes `status` only, with an audit event.
 * appointmentId / customerId / staffId are plain id columns, not relation fields: appointments, customers and staff
 * are UI-managed collections that NocoBase loads after plugin collections, and a code-defined belongsTo to them
 * fails at startup (the same reason @parlour/plugin-appointment-availability stores only ids). No database
 * constraints either, so existing appointment, customer and staff management (including deletes) is unchanged.
 */
export default defineCollection({
  name: REVIEWS,
  title: 'Customer reviews',
  filterTargetKey: 'id',
  autoGenId: false,
  timestamps: true,
  fields: [
    { type: 'snowflakeId', name: 'id', primaryKey: true, allowNull: false },
    { type: 'bigInt', name: 'appointmentId', allowNull: false },
    { type: 'bigInt', name: 'customerId', allowNull: false, index: true },
    { type: 'bigInt', name: 'staffId', allowNull: false },
    // The invitation that authorized this review. Unique: an invitation can authorize at most one review.
    { type: 'bigInt', name: 'invitationId', allowNull: false, unique: true },
    { type: 'integer', name: 'rating', allowNull: false, validate: { isInt: true, min: 1, max: 5 } },
    { type: 'text', name: 'comment' },
    // submitted | flagged. Both count towards the score; flagging only marks a review for attention.
    { type: 'string', name: 'status', allowNull: false, defaultValue: 'submitted' },
    { type: 'datetimeTz', name: 'submittedAt', allowNull: false },
    { type: 'belongsTo', name: 'invitation', target: INVITATIONS, foreignKey: 'invitationId', constraints: false },
    { type: 'hasMany', name: 'moderationEvents', target: MODERATION_EVENTS, foreignKey: 'reviewId', constraints: false },
  ],
  indexes: [
    // Database-level duplicate prevention: one review per appointment and technician.
    { unique: true, fields: ['appointmentId', 'staffId'], name: 'customer_reviews_appointment_staff_unique' },
    { fields: ['staffId', 'submittedAt'], name: 'customer_reviews_staff_submitted' },
    { fields: ['submittedAt'], name: 'customer_reviews_submitted' },
  ],
});
