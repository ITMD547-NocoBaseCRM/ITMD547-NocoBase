import { defineCollection } from '@nocobase/database';
import { bindingsCollection } from '../../constants';

/**
 * One row per NocoBase session issued through Clerk. `(userId, signInTime)` identifies the NocoBase
 * session across token renewals (renewal changes the jti but keeps signInTime), and
 * `clerkSessionId` is the Clerk session it was issued from, so sign-out and revocation checks can
 * reach the right Clerk session.
 */
export default defineCollection({
  name: bindingsCollection,
  dumpRules: { skipped: true },
  migrationRules: ['schema-only'],
  shared: true,
  fields: [
    { name: 'userId', type: 'bigInt', allowNull: false },
    { name: 'signInTime', type: 'bigInt', allowNull: false },
    { name: 'clerkUserId', type: 'string', allowNull: false },
    { name: 'clerkSessionId', type: 'string', allowNull: false },
    { name: 'lastCheckedAt', type: 'date', allowNull: false },
    { name: 'revokedAt', type: 'date' },
    { name: 'revokedReason', type: 'string' },
  ],
  indexes: [{ unique: true, fields: ['userId', 'signInTime'] }],
});
