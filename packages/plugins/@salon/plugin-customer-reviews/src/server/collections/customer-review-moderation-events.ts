import { defineCollection } from '@nocobase/database';
import { MODERATION_EVENTS, REVIEWS } from '../../constants';

/** Append-only audit trail of moderation actions on reviews. The review's rating and comment are never edited. */
export default defineCollection({
  name: MODERATION_EVENTS,
  title: 'Customer review moderation events',
  filterTargetKey: 'id',
  autoGenId: false,
  timestamps: true,
  fields: [
    { type: 'snowflakeId', name: 'id', primaryKey: true, allowNull: false },
    { type: 'bigInt', name: 'reviewId', allowNull: false, index: true },
    // flag | unflag
    { type: 'string', name: 'action', allowNull: false },
    { type: 'string', name: 'fromStatus' },
    { type: 'string', name: 'toStatus' },
    { type: 'text', name: 'reason' },
    { type: 'bigInt', name: 'createdById' },
    { type: 'belongsTo', name: 'createdBy', target: 'users', foreignKey: 'createdById', constraints: false },
    { type: 'belongsTo', name: 'review', target: REVIEWS, foreignKey: 'reviewId', constraints: false },
  ],
});
