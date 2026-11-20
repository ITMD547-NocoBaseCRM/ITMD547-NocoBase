import { randomBytes, timingSafeEqual } from 'crypto';
import type { Database, Model } from '@nocobase/database';
import { ClerkErrorCode, invitationMetadataKey, invitationsCollection, linksCollection } from '../constants';
import type { ClerkApi } from './clerk-api';
import type { ClerkConfig } from './config';
import { ClerkAuthError } from './errors';
import type { StaffAccess } from './staff-access';
import type { VerifiedClerkSession } from './token-verifier';

type Logger = { info: (...args: any[]) => void; warn: (...args: any[]) => void; error: (...args: any[]) => void };

export type InvitationDeps = {
  db: Database;
  logger: Logger;
  staffAccess: StaffAccess;
  getConfig: () => ClerkConfig;
  getClerkApi: () => ClerkApi;
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Tolerance between Clerk's and this server's clocks when comparing account creation time. */
const CLOCK_SKEW_MS = 5 * 60_000;

const fail = (status: number, code: string, message: string, reason?: string) =>
  new ClerkAuthError(status, code, message, reason);

const sameSecret = (a: unknown, b: unknown) => {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
};

const isUniqueViolation = (error: any) =>
  error?.name === 'SequelizeUniqueConstraintError' || error?.parent?.code === '23505';

/** Clerk "already exists" style failures when creating an invitation. */
const isClerkDuplicate = (error: any) =>
  error?.status === 422 &&
  (error?.errors || []).some((e: any) => /exists|duplicate|taken/i.test(`${e?.code} ${e?.message} ${e?.longMessage}`));

export type PublicInvitation = {
  id: number;
  email: string;
  userId: number;
  user?: unknown;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  expiresAt: string;
  lastSentAt?: string;
  acceptedAt?: string;
  clerkUserId?: string;
  note?: string;
  createdAt?: string;
};

/**
 * Invitation-only staff registration.
 *
 * Invite: an administrator picks an address and an existing NocoBase user. The pairing is stored
 * here; Clerk gets the address, a redirect to the public `/staff-invite` page, and public metadata
 * `{ id, nonce }` pointing at this row.
 *
 * Accept: the new Clerk account calls `accept` with its session token. The link is created only if
 * everything checks out server-side; nothing from the URL or the browser is used.
 */
export class StaffInvitations {
  constructor(private deps: InvitationDeps) {}

  private get repo() {
    return this.deps.db.getRepository(invitationsCollection);
  }

  private get links() {
    return this.deps.db.getRepository(linksCollection);
  }

  static effectiveStatus(record: Model): PublicInvitation['status'] {
    const status = record.get('status');
    if (status === 'pending' && new Date(record.get('expiresAt')).getTime() <= Date.now()) return 'expired';
    return status;
  }

  /** What the admin UI may see: never the nonce. */
  static toPublic(record: Model): PublicInvitation {
    const { nonce: _nonce, ...rest } = record.toJSON() as any;
    return { ...rest, status: StaffInvitations.effectiveStatus(record) };
  }

  async list() {
    const rows = await this.repo.find({ sort: ['-createdAt'], appends: ['user', 'user.roles'], limit: 500 });
    return rows.map((row: Model) => StaffInvitations.toPublic(row));
  }

  /** Target must exist, hold a staff role, not be root, and not already be linked. */
  private async assertInvitableUser(userId: number) {
    const user = userId ? await this.deps.db.getRepository('users').findOne({ filterByTk: userId }) : null;
    if (!user) throw fail(400, ClerkErrorCode.NOT_LINKED, 'Choose an existing NocoBase user.');
    try {
      await this.deps.staffAccess.assertStaffRole(user.get('id'));
    } catch (error) {
      if (error instanceof ClerkAuthError) {
        throw fail(400, error.code, `This user cannot use staff sign-in: ${error.message}`);
      }
      throw error;
    }
    if (await this.links.findOne({ filter: { userId: user.get('id') } })) {
      throw fail(409, ClerkErrorCode.LINK_CONFLICT, 'This user is already linked to a Clerk account.');
    }
    return user;
  }

  private ttlMs() {
    return this.deps.getConfig().invitationTtlDays * 24 * 60 * 60 * 1000;
  }

  private async sendClerkInvitation(record: Model) {
    const config = this.deps.getConfig();
    try {
      return await this.deps.getClerkApi().createInvitation({
        emailAddress: record.get('email'),
        redirectUrl: config.inviteRedirectUrl,
        publicMetadata: { [invitationMetadataKey]: { id: record.get('id'), nonce: record.get('nonce') } },
        expiresInDays: config.invitationTtlDays,
      });
    } catch (error: any) {
      if (isClerkDuplicate(error)) {
        throw fail(
          409,
          ClerkErrorCode.LINK_CONFLICT,
          'Clerk already has an account or a pending invitation for this email. Use "Link staff account" for existing Clerk accounts.',
        );
      }
      this.deps.logger.warn('auth-clerk: Clerk createInvitation failed', { error: error?.message });
      throw fail(502, ClerkErrorCode.UNAVAILABLE, 'Clerk could not send the invitation. Try again.');
    }
  }

  async invite(values: { email?: unknown; userId?: unknown; note?: unknown }) {
    const email = typeof values.email === 'string' ? values.email.trim().toLowerCase() : '';
    if (!EMAIL.test(email)) throw fail(400, ClerkErrorCode.NOT_INVITED, 'Enter a valid email address.');
    const user = await this.assertInvitableUser(Number(values.userId));

    const now = Date.now();
    const open = (await this.repo.find({ filter: { status: 'pending' } })).filter(
      (row: Model) =>
        new Date(row.get('expiresAt')).getTime() > now &&
        (row.get('email') === email || String(row.get('userId')) === String(user.get('id'))),
    );
    if (open.length) {
      throw fail(
        409,
        ClerkErrorCode.LINK_CONFLICT,
        'There is already a pending invitation for this email or user. Resend or revoke it instead.',
      );
    }

    const record = await this.repo.create({
      values: {
        email,
        userId: user.get('id'),
        status: 'pending',
        nonce: randomBytes(24).toString('hex'),
        expiresAt: new Date(now + this.ttlMs()),
        note: typeof values.note === 'string' ? values.note.slice(0, 1000) : null,
      },
    });
    let clerkInvitation;
    try {
      clerkInvitation = await this.sendClerkInvitation(record);
    } catch (error) {
      await this.repo.destroy({ filterByTk: record.get('id') });
      throw error;
    }
    await this.repo.update({
      filterByTk: record.get('id'),
      values: { clerkInvitationId: clerkInvitation.id, lastSentAt: new Date() },
    });
    this.deps.logger.info('auth-clerk: staff invitation sent', {
      invitationId: record.get('id'),
      userId: user.get('id'),
    });
    return StaffInvitations.toPublic(await this.repo.findOne({ filterByTk: record.get('id'), appends: ['user'] }));
  }

  private async findManageable(id: unknown) {
    const record = id ? await this.repo.findOne({ filterByTk: id as any }) : null;
    if (!record) throw fail(404, ClerkErrorCode.NOT_INVITED, 'Invitation not found.');
    if (record.get('status') !== 'pending') {
      throw fail(409, ClerkErrorCode.INVITATION_USED, `This invitation is already ${record.get('status')}.`);
    }
    return record;
  }

  /** Revokes the previous Clerk invitation and sends a fresh one (new link, new expiry). */
  async resend(id: unknown) {
    const record = await this.findManageable(id);
    await this.assertInvitableUser(record.get('userId'));
    const previous = record.get('clerkInvitationId');
    if (previous) {
      try {
        await this.deps.getClerkApi().revokeInvitation(previous);
      } catch (error: any) {
        // Already expired/revoked on Clerk's side is fine; anything else must not leave two live links.
        if (!(error?.status >= 400 && error?.status < 500)) {
          throw fail(502, ClerkErrorCode.UNAVAILABLE, 'Clerk could not be reached. Try again.');
        }
      }
    }
    const clerkInvitation = await this.sendClerkInvitation(record);
    await this.repo.update({
      filterByTk: record.get('id'),
      values: {
        clerkInvitationId: clerkInvitation.id,
        lastSentAt: new Date(),
        expiresAt: new Date(Date.now() + this.ttlMs()),
      },
    });
    this.deps.logger.info('auth-clerk: staff invitation resent', { invitationId: record.get('id') });
    return StaffInvitations.toPublic(await this.repo.findOne({ filterByTk: record.get('id'), appends: ['user'] }));
  }

  async revoke(id: unknown) {
    const record = await this.findManageable(id);
    const clerkInvitationId = record.get('clerkInvitationId');
    if (clerkInvitationId) {
      try {
        await this.deps.getClerkApi().revokeInvitation(clerkInvitationId);
      } catch (error: any) {
        if (!(error?.status >= 400 && error?.status < 500)) {
          throw fail(502, ClerkErrorCode.UNAVAILABLE, 'Clerk could not be reached. Try again.');
        }
        // 4xx: already accepted/expired/revoked on Clerk. Revoking here still blocks acceptance.
      }
    }
    await this.repo.update({ filterByTk: record.get('id'), values: { status: 'revoked' } });
    this.deps.logger.info('auth-clerk: staff invitation revoked', { invitationId: record.get('id') });
    return StaffInvitations.toPublic(await this.repo.findOne({ filterByTk: record.get('id'), appends: ['user'] }));
  }

  /**
   * Removes an invitation in any state. A pending one is revoked in Clerk first so its emailed link
   * stops working. Links created by an accepted invitation are kept; use "Unlink" to remove access.
   */
  async destroy(id: unknown) {
    const record = id ? await this.repo.findOne({ filterByTk: id as any }) : null;
    if (!record) throw fail(404, ClerkErrorCode.NOT_INVITED, 'Invitation not found.');
    const clerkInvitationId = record.get('clerkInvitationId');
    if (record.get('status') === 'pending' && clerkInvitationId) {
      try {
        await this.deps.getClerkApi().revokeInvitation(clerkInvitationId);
      } catch (error: any) {
        if (!(error?.status >= 400 && error?.status < 500)) {
          throw fail(502, ClerkErrorCode.UNAVAILABLE, 'Clerk could not be reached. Try again.');
        }
      }
    }
    await this.repo.destroy({ filterByTk: record.get('id') });
    this.deps.logger.info('auth-clerk: staff invitation deleted', { invitationId: record.get('id') });
    return { id: record.get('id') };
  }

  /**
   * Links a freshly registered Clerk account to the invitation's NocoBase user. Every fact used is
   * fetched server-side; repeating the call with the same account is a harmless no-op.
   */
  async accept(session: VerifiedClerkSession): Promise<{ userId: number; alreadyLinked: boolean }> {
    const api = this.deps.getClerkApi();
    const clerkUser = await api.getUser(session.clerkUserId);
    if (!clerkUser) throw fail(401, ClerkErrorCode.TOKEN_INVALID, 'Your Clerk account could not be found.');

    // 1. Proof the account came from one of our invitations: public metadata is server-written only.
    const ref = clerkUser.publicMetadata?.[invitationMetadataKey] as { id?: unknown; nonce?: unknown } | undefined;
    const invitation = ref?.id ? await this.repo.findOne({ filterByTk: ref.id as any }) : null;
    if (!invitation || !sameSecret(invitation.get('nonce'), ref?.nonce)) {
      throw fail(
        403,
        ClerkErrorCode.NOT_INVITED,
        'This Clerk account was not created from a staff invitation. Ask an administrator to invite you.',
        `clerk user ${clerkUser.id} has no valid invitation reference`,
      );
    }

    // 2. Already accepted: only the same account may "accept" again (idempotent).
    if (invitation.get('status') === 'accepted') {
      if (invitation.get('clerkUserId') === clerkUser.id) {
        const link = await this.links.findOne({ filter: { clerkUserId: clerkUser.id } });
        if (link && String(link.get('userId')) === String(invitation.get('userId'))) {
          return { userId: invitation.get('userId'), alreadyLinked: true };
        }
      }
      throw fail(409, ClerkErrorCode.INVITATION_USED, 'This invitation has already been used.');
    }
    if (invitation.get('status') === 'revoked') {
      throw fail(
        410,
        ClerkErrorCode.INVITATION_REVOKED,
        'This invitation was revoked. Ask an administrator for a new one.',
      );
    }
    if (StaffInvitations.effectiveStatus(invitation) === 'expired') {
      throw fail(
        410,
        ClerkErrorCode.INVITATION_EXPIRED,
        'This invitation has expired. Ask an administrator to resend it.',
      );
    }

    // 3. Clerk must confirm the invitation itself was accepted (the ticket sign-up happened).
    let clerkInvitation;
    try {
      clerkInvitation = await api.findInvitation(invitation.get('clerkInvitationId'), invitation.get('email'));
    } catch (error: any) {
      throw fail(503, ClerkErrorCode.UNAVAILABLE, 'Clerk could not be reached. Try again.', error?.message);
    }
    if (!clerkInvitation || clerkInvitation.status !== 'accepted') {
      const status = clerkInvitation?.status;
      if (status === 'revoked') throw fail(410, ClerkErrorCode.INVITATION_REVOKED, 'This invitation was revoked.');
      if (status === 'expired') throw fail(410, ClerkErrorCode.INVITATION_EXPIRED, 'This invitation has expired.');
      throw fail(
        403,
        ClerkErrorCode.INVITATION_NOT_ACCEPTED,
        'This invitation has not been accepted in Clerk.',
        `clerk status ${status}`,
      );
    }

    // 4. The account must own the invited address (verified) and be newer than the invitation.
    if (!clerkUser.verifiedEmails.includes(invitation.get('email'))) {
      throw fail(403, ClerkErrorCode.NOT_INVITED, 'This Clerk account does not have the invited email address.');
    }
    if (clerkUser.createdAt + CLOCK_SKEW_MS < new Date(invitation.get('createdAt')).getTime()) {
      throw fail(403, ClerkErrorCode.NOT_INVITED, 'This Clerk account existed before the invitation was sent.');
    }

    // 5. The target user must still be eligible (staff role, not root). Roles are never changed.
    const userId = invitation.get('userId');
    if (!(await this.deps.db.getRepository('users').findOne({ filterByTk: userId }))) {
      throw fail(409, ClerkErrorCode.LINK_CONFLICT, 'The invited staff account no longer exists.');
    }
    await this.deps.staffAccess.assertStaffRole(userId);

    // 6. No conflicting links, then link + mark accepted together.
    const assertNoConflict = async () => {
      const byClerk = await this.links.findOne({ filter: { clerkUserId: clerkUser.id } });
      const byUser = await this.links.findOne({ filter: { userId } });
      if (byClerk && String(byClerk.get('userId')) !== String(userId)) {
        throw fail(409, ClerkErrorCode.LINK_CONFLICT, 'This Clerk account is already linked to another staff account.');
      }
      if (byUser && byUser.get('clerkUserId') !== clerkUser.id) {
        throw fail(409, ClerkErrorCode.LINK_CONFLICT, 'This staff account is already linked to another Clerk account.');
      }
      return !!byClerk;
    };
    const alreadyLinked = await assertNoConflict();

    try {
      await this.deps.db.sequelize.transaction(async (transaction) => {
        // Conditional update: only one request can move this invitation out of "pending".
        const [moved] = await this.deps.db
          .getModel(invitationsCollection)
          .update(
            { status: 'accepted', acceptedAt: new Date(), clerkUserId: clerkUser.id },
            { where: { id: invitation.get('id'), status: 'pending' }, transaction },
          );
        if (!moved) throw Object.assign(new Error('invitation no longer pending'), { raced: true });
        if (!alreadyLinked) {
          await this.links.create({
            values: {
              clerkUserId: clerkUser.id,
              userId,
              enabled: true,
              clerkEmail: invitation.get('email'),
              note: `Accepted staff invitation #${invitation.get('id')}`,
            },
            transaction,
          });
        }
      });
    } catch (error: any) {
      if (error?.raced || isUniqueViolation(error)) {
        // A concurrent request won. Same account and same user means success; anything else is a conflict.
        const link = await this.links.findOne({ filter: { clerkUserId: clerkUser.id } });
        if (link && String(link.get('userId')) === String(userId)) return { userId, alreadyLinked: true };
        throw fail(409, ClerkErrorCode.LINK_CONFLICT, 'This invitation or account was linked by another request.');
      }
      throw error;
    }
    await this.deps.staffAccess.clearAccessCache(userId);
    this.deps.logger.info('auth-clerk: staff invitation accepted', {
      invitationId: invitation.get('id'),
      userId,
      clerkUserId: clerkUser.id,
    });
    return { userId, alreadyLinked };
  }
}
