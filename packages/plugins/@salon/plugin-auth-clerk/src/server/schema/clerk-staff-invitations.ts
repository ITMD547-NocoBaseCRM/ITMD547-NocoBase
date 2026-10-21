import { defineCollection } from '@nocobase/database';
import { invitationsCollection } from '../../constants';

/**
 * Staff invitations sent through Clerk. The NocoBase user an invitation is for lives only here, on
 * the server; Clerk only carries `{ id, nonce }` of this row in the invited account's public
 * metadata (which only the Backend API can write).
 *
 * status: 'pending' | 'accepted' | 'revoked'. "Expired" is derived from `expiresAt`.
 */
export default defineCollection({
  name: invitationsCollection,
  dumpRules: { group: 'user' },
  migrationRules: ['schema-only', 'overwrite'],
  shared: true,
  createdBy: true,
  updatedBy: true,
  fields: [
    { name: 'email', type: 'string', allowNull: false },
    { name: 'userId', type: 'bigInt', allowNull: false },
    { name: 'user', type: 'belongsTo', target: 'users', foreignKey: 'userId', targetKey: 'id', onDelete: 'CASCADE' },
    { name: 'status', type: 'string', allowNull: false, defaultValue: 'pending' },
    // Random secret echoed back through Clerk public metadata; never returned to the browser.
    { name: 'nonce', type: 'string', allowNull: false, hidden: true },
    { name: 'clerkInvitationId', type: 'string', unique: true },
    { name: 'expiresAt', type: 'date', allowNull: false },
    { name: 'lastSentAt', type: 'date' },
    { name: 'acceptedAt', type: 'date' },
    { name: 'clerkUserId', type: 'string' },
    { name: 'note', type: 'text' },
  ],
});
