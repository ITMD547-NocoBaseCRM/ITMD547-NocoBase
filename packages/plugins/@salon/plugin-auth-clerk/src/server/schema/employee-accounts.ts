import { defineCollection } from '@nocobase/database';

/**
 * Per-employee onboarding state that can't be derived from users, roles, Clerk links and invitations.
 * Plain id columns (no relations to UI-managed collections). Ids are stored as strings (snowflake ids).
 */
export const employeeAccountsCollection = defineCollection({
  name: 'employeeAccounts',
  dumpRules: { group: 'user' },
  migrationRules: ['schema-only', 'overwrite'],
  shared: true,
  createdBy: true,
  updatedBy: true,
  fields: [
    { name: 'staffId', type: 'string', allowNull: false, unique: true },
    { name: 'disabled', type: 'boolean', allowNull: false, defaultValue: false },
    { name: 'disabledRoles', type: 'json' },
    { name: 'lastError', type: 'text' },
    { name: 'lastErrorAt', type: 'date' },
  ],
});

/** Append-only audit history of account provisioning (who did what to which employee account, and when). */
export const employeeAccountEventsCollection = defineCollection({
  name: 'employeeAccountEvents',
  dumpRules: { group: 'user' },
  migrationRules: ['schema-only', 'overwrite'],
  shared: true,
  fields: [
    { name: 'staffId', type: 'string', allowNull: false, index: true },
    { name: 'userId', type: 'string' },
    { name: 'action', type: 'string', allowNull: false },
    { name: 'actorId', type: 'string' },
    { name: 'detail', type: 'json' },
  ],
});
