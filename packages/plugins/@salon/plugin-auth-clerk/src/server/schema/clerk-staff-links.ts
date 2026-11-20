import { defineCollection } from '@nocobase/database';
import { linksCollection } from '../../constants';

/**
 * Administrator-managed mapping from a Clerk user (stable `user_...` id) to an existing NocoBase
 * user. A Clerk identity without a row here cannot sign in. Rows are only created through the
 * `clerkStaffLinks:create` action, which checks the Clerk id against Clerk's Backend API.
 */
export default defineCollection({
  name: linksCollection,
  dumpRules: { group: 'user' },
  migrationRules: ['schema-only', 'overwrite'],
  shared: true,
  createdBy: true,
  updatedBy: true,
  fields: [
    {
      name: 'clerkUserId',
      type: 'string',
      allowNull: false,
      unique: true,
    },
    {
      name: 'userId',
      type: 'bigInt',
      allowNull: false,
      unique: true,
    },
    {
      name: 'user',
      type: 'belongsTo',
      target: 'users',
      foreignKey: 'userId',
      targetKey: 'id',
      onDelete: 'CASCADE',
    },
    {
      name: 'enabled',
      type: 'boolean',
      allowNull: false,
      defaultValue: true,
    },
    {
      // Display snapshot taken from Clerk when the link was made. Never used for authentication.
      name: 'clerkEmail',
      type: 'string',
    },
    {
      name: 'note',
      type: 'text',
    },
    {
      name: 'lastSignInAt',
      type: 'date',
    },
  ],
});
