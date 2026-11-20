import { Op } from '@nocobase/database';
import type { Application } from '@nocobase/server';
import { randomUUID } from 'node:crypto';
import { DELIVERIES, INVITATIONS, MODERATION_EVENTS, REVIEWS } from '../constants';
import { renderInvitationEmail } from './core/email';
import {
  activeKeyOf,
  emailDeliveryDecision,
  invitationState,
  isReviewableAppointment,
  sanitizeError,
  SKIP_MESSAGES,
  SkipReason,
  technicianIds,
  validateSubmission,
} from './core/policy';
import { aggregateScores, MIN_RANKABLE_REVIEWS } from './core/scores';
import { generateToken, hashToken, isWellFormedToken, reviewUrl } from './core/tokens';
import { ReviewMailer } from './mailer';

export const INVITATION_TTL_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const SEND_LOCK_MS = 5 * 60 * 1000;

/** Marks a transaction as one opened by this service: the model hooks refuse review writes from anywhere else. */
export const SUBMISSION_FLAG = '__customerReviewSubmission';
export const MODERATION_FLAG = '__customerReviewModeration';

export class ReviewError extends Error {
  status: number;
  code: string;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export type DeliveryOutcome = {
  status: 'sent' | 'failed' | 'skipped' | 'duplicate' | 'in_progress';
  deliveryId?: string;
  invitations?: number;
  reason?: string;
  message?: string;
};

export type PublicState = 'valid' | 'invalid' | 'expired' | 'revoked' | 'used' | 'ineligible';

const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
const isUnique = (error: any) => error && (error.name === 'SequelizeUniqueConstraintError' || error.parent?.code === '23505');
const staffName = (s: any) => (s ? [s.firstName, s.lastName].filter(Boolean).join(' ').trim() : '') || 'your technician';

export class ReviewService {
  private readonly app: Application;
  readonly mailer: ReviewMailer;

  constructor(app: Application) {
    this.app = app;
    this.mailer = new ReviewMailer(app);
  }

  private get db() {
    return this.app.db;
  }
  private repo(name: string) {
    return this.db.getRepository(name);
  }
  private model(name: string): any {
    return this.db.getModel(name);
  }

  // ------------------------------------------------------------------ configuration

  get secret(): string | undefined {
    return process.env.APP_KEY || undefined;
  }

  /** Public base URL of the CRM (where /review is served). HTTPS is required in production. */
  baseUrl(): string {
    const port = process.env.APP_PORT || 13000;
    const url = (process.env.REVIEW_PUBLIC_BASE_URL || process.env.APP_PUBLIC_URL || `http://localhost:${port}`).trim().replace(/\/+$/, '');
    const production = process.env.APP_ENV === 'production' || process.env.NODE_ENV === 'production';
    if (production && !/^https:\/\//i.test(url)) {
      throw new ReviewError('config', 'REVIEW_PUBLIC_BASE_URL must be an https:// address in production.', 500);
    }
    return url;
  }

  private hash(token: string) {
    return hashToken(token, this.secret);
  }

  // ------------------------------------------------------------------ loading

  async loadAppointment(appointmentId: unknown, transaction?: any) {
    if (appointmentId === null || appointmentId === undefined || appointmentId === '') return null;
    const row = await this.repo('appointments').findOne({
      filterByTk: appointmentId as any,
      appends: ['customer', 'staff', 'service', 'appointmentServices', 'appointmentServices.service'],
      transaction,
    });
    return row ? row.toJSON() : null;
  }

  async loadSuppressions(customerId: unknown, transaction?: any) {
    if (!this.db.getCollection('communication_suppressions')) return [];
    const rows = await this.repo('communication_suppressions').find({ filter: { customerId, active: true }, transaction });
    return rows.map((r: any) => r.toJSON());
  }

  private async staffById(ids: string[], transaction?: any): Promise<Record<string, any>> {
    if (!ids.length) return {};
    const rows = await this.repo('staff').find({ filter: { id: { $in: ids } }, fields: ['id', 'firstName', 'lastName', 'role', 'active'], transaction });
    return Object.fromEntries(rows.map((r: any) => [String(r.get('id')), r.toJSON()]));
  }

  serviceNames(appointment: any): string[] {
    const fromLines = (appointment?.appointmentServices || []).map((l: any) => l?.service?.name).filter(Boolean);
    const names = fromLines.length ? fromLines : appointment?.service?.name ? [appointment.service.name] : [];
    return Array.from(new Set(names.map(String)));
  }

  /** Technicians who performed the appointment and still exist as staff records. */
  async eligibleTechnicians(appointment: any, transaction?: any) {
    const ids = technicianIds(appointment);
    const staff = await this.staffById(ids, transaction);
    return ids.filter((id) => staff[id]).map((id) => ({ staffId: id, name: staffName(staff[id]) }));
  }

  // ------------------------------------------------------------------ automatic invitations

  /**
   * Creates invitations for every eligible technician who has neither a review nor an active invitation, and
   * sends one email with all their links. Idempotent per `idempotencyKey` (one completion event).
   */
  async sendForAppointment(options: { appointmentId: unknown; trigger: string; idempotencyKey: string; userId?: unknown }): Promise<DeliveryOutcome> {
    const { appointmentId, trigger, idempotencyKey } = options;
    const userId = str(options.userId);

    const existing = await this.repo(DELIVERIES).findOne({ filter: { idempotencyKey } });
    if (existing) return this.resumeExisting(existing.toJSON(), userId);

    const appointment = await this.loadAppointment(appointmentId);
    const skip = (reason: SkipReason) => this.recordSkip({ appointmentId, customerId: appointment?.customerId, idempotencyKey, trigger, userId, reason });
    if (!appointment || !isReviewableAppointment(appointment)) return skip('appointment_ineligible');
    const decision = emailDeliveryDecision(appointment.customer, await this.loadSuppressions(appointment.customerId));
    if (decision.allowed === false) return skip(decision.reason);
    const technicians = await this.eligibleTechnicians(appointment);
    if (!technicians.length) return skip('no_technicians');

    const tokens = new Map<string, string>();
    const transaction = await this.db.sequelize.transaction();
    let deliveryId: string;
    try {
      const delivery = await this.repo(DELIVERIES).create({
        values: { appointmentId: appointment.id, customerId: appointment.customerId, idempotencyKey, trigger, status: 'pending', createdById: userId },
        transaction,
      });
      deliveryId = String(delivery.get('id'));
      for (const tech of technicians) {
        if (await this.hasReview(appointment.id, tech.staffId, transaction)) continue;
        const active = await this.activeInvitation(appointment.id, tech.staffId, transaction);
        if (active && invitationState(active) === 'active') continue;
        if (active) await this.retire(active.id, 'expired, replaced', transaction);
        const token = generateToken();
        const invitation = await this.repo(INVITATIONS).create({
          values: {
            appointmentId: appointment.id,
            customerId: appointment.customerId,
            staffId: tech.staffId,
            tokenHash: this.hash(token),
            activeKey: activeKeyOf(appointment.id, tech.staffId),
            expiresAt: new Date(Date.now() + INVITATION_TTL_DAYS * DAY_MS),
            channel: 'email',
            deliveryStatus: 'pending',
            deliveryId,
            createdById: userId,
          },
          transaction,
        });
        tokens.set(String(invitation.get('id')), token);
      }
      if (!tokens.size) {
        await this.repo(DELIVERIES).update({
          filterByTk: deliveryId,
          values: { status: 'skipped', skipReason: 'already_invited', skipMessage: SKIP_MESSAGES.already_invited },
          transaction,
        });
      } else {
        await this.repo(DELIVERIES).update({ filterByTk: deliveryId, values: { invitationCount: tokens.size }, transaction });
      }
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      // A concurrent run won the race for the same event or the same technician: nothing to do twice.
      if (isUnique(error)) return { status: 'duplicate', reason: 'already_invited', message: SKIP_MESSAGES.already_invited };
      throw error;
    }
    if (!tokens.size) return { status: 'skipped', deliveryId, reason: 'already_invited', message: SKIP_MESSAGES.already_invited };
    return this.dispatch(deliveryId, tokens);
  }

  private async recordSkip(o: { appointmentId: unknown; customerId?: unknown; idempotencyKey: string; trigger: string; userId: string | null; reason: SkipReason }): Promise<DeliveryOutcome> {
    try {
      const row = await this.repo(DELIVERIES).create({
        values: {
          appointmentId: o.appointmentId,
          customerId: o.customerId ?? null,
          idempotencyKey: o.idempotencyKey,
          trigger: o.trigger,
          status: 'skipped',
          skipReason: o.reason,
          skipMessage: SKIP_MESSAGES[o.reason],
          createdById: o.userId,
        },
      });
      return { status: 'skipped', deliveryId: String(row.get('id')), reason: o.reason, message: SKIP_MESSAGES[o.reason] };
    } catch (error) {
      if (isUnique(error)) return { status: 'duplicate', reason: o.reason, message: SKIP_MESSAGES[o.reason] };
      throw error;
    }
  }

  /** The same event ran again (workflow retry or re-run): never send twice; finish an interrupted send. */
  private async resumeExisting(delivery: any, userId: string | null): Promise<DeliveryOutcome> {
    const id = String(delivery.id);
    if (delivery.status === 'sent' || delivery.status === 'skipped') return { status: 'duplicate', deliveryId: id, reason: delivery.skipReason || undefined };
    const lockHeld = delivery.status === 'sending' && delivery.lockedUntil && new Date(delivery.lockedUntil).getTime() > Date.now();
    if (lockHeld) return { status: 'in_progress', deliveryId: id };
    // pending/failed, or a send that crashed: tokens were only in memory, so new ones are issued (old links stop working).
    return this.resendDelivery(id, { userId, trigger: 'retry', allowSent: false });
  }

  private async hasReview(appointmentId: unknown, staffId: unknown, transaction?: any) {
    return !!(await this.repo(REVIEWS).findOne({ filter: { appointmentId, staffId }, fields: ['id'], transaction }));
  }

  private async activeInvitation(appointmentId: unknown, staffId: unknown, transaction?: any) {
    const row = await this.repo(INVITATIONS).findOne({ filter: { activeKey: activeKeyOf(appointmentId, staffId) }, transaction });
    return row ? row.toJSON() : null;
  }

  /** Takes an invitation out of service (it no longer authorizes a review and frees its active slot). */
  private async retire(invitationId: unknown, reason: string, transaction?: any) {
    await this.model(INVITATIONS).update(
      { revokedAt: new Date(), revokedReason: reason, activeKey: null },
      { where: { id: invitationId, usedAt: null, revokedAt: null }, transaction },
    );
  }

  // ------------------------------------------------------------------ sending

  /**
   * Sends one delivery's email. The conditional claim (status + attempts compare-and-set) makes sure only one
   * process sends a given delivery at a time; the lock expires after 5 minutes so a crashed send can be retried.
   */
  async dispatch(deliveryId: string, tokens: Map<string, string>): Promise<DeliveryOutcome> {
    const Delivery = this.model(DELIVERIES);
    const current = await Delivery.findOne({ where: { id: deliveryId } });
    if (!current) throw new ReviewError('not_found', 'Delivery not found.', 404);
    const now = new Date();
    const attempts = Number(current.get('attempts') || 0);
    const [claimed] = await Delivery.update(
      { status: 'sending', attempts: attempts + 1, lockedUntil: new Date(now.getTime() + SEND_LOCK_MS), lastError: null },
      {
        where: {
          id: deliveryId,
          attempts,
          [Op.or]: [{ status: { [Op.in]: ['pending', 'failed'] } }, { status: 'sending', lockedUntil: { [Op.lt]: now } }],
        },
      },
    );
    if (!claimed) return { status: 'in_progress', deliveryId };

    const invitationIds = Array.from(tokens.keys());
    let links: { technicianName: string; url: string }[] = [];
    let to = '';
    let customerName = '';
    try {
      const invitations = (await this.repo(INVITATIONS).find({ filter: { id: { $in: invitationIds } } })).map((r: any) => r.toJSON());
      const usable = invitations.filter((inv: any) => invitationState(inv) === 'active');
      const staff = await this.staffById(usable.map((inv: any) => String(inv.staffId)));
      usable.forEach((inv: any) => {
        inv.staff = staff[String(inv.staffId)];
      });
      if (!usable.length) throw new ReviewError('nothing_to_send', 'None of the invitations in this email is still active.', 409);
      const appointment = await this.loadAppointment(usable[0].appointmentId);
      if (!appointment || !isReviewableAppointment(appointment)) throw new ReviewError('ineligible', SKIP_MESSAGES.appointment_ineligible, 409);
      const decision = emailDeliveryDecision(appointment.customer, await this.loadSuppressions(appointment.customerId));
      if (decision.allowed === false) throw new ReviewError(decision.reason, decision.message, 409);
      const base = this.baseUrl();
      links = usable
        .sort((a: any, b: any) => staffName(a.staff).localeCompare(staffName(b.staff)))
        .map((inv: any) => ({ technicianName: staffName(inv.staff), url: reviewUrl(base, tokens.get(String(inv.id)) as string) }));
      to = String(appointment.customer.email).trim();
      customerName = appointment.customer.firstName || '';
      const mail = renderInvitationEmail({ customerName, links });
      const host = (() => {
        try {
          return new URL(base).hostname || 'beautywithin.local';
        } catch {
          return 'beautywithin.local';
        }
      })();
      const sent = await this.mailer.send({
        to,
        ...mail,
        messageId: `<review-${deliveryId}-${attempts + 1}@${host}>`,
        entityRef: `review-${deliveryId}-${attempts + 1}`,
      });
      const sentAt = new Date();
      await Delivery.update({ status: 'sent', sentAt, lockedUntil: null, messageId: String(sent.messageId).slice(0, 250) }, { where: { id: deliveryId } });
      for (const inv of usable) {
        await this.model(INVITATIONS).update(
          { deliveryStatus: 'sent', sentAt, sendAttempts: Number(inv.sendAttempts || 0) + 1, lastSendError: null },
          { where: { id: inv.id } },
        );
      }
      this.app.logger.info('customer-reviews: invitation email sent', { deliveryId, invitations: usable.length });
      return { status: 'sent', deliveryId, invitations: usable.length };
    } catch (error) {
      const message = error instanceof ReviewError ? error.message : sanitizeError(error);
      await Delivery.update({ status: 'failed', lockedUntil: null, lastError: message }, { where: { id: deliveryId } });
      const rows = await this.model(INVITATIONS).findAll({ where: { id: invitationIds } });
      for (const inv of rows) {
        await inv.update({ deliveryStatus: 'failed', sendAttempts: Number(inv.get('sendAttempts') || 0) + 1, lastSendError: message });
      }
      this.app.logger.warn('customer-reviews: invitation email failed', { deliveryId, reason: message });
      return { status: 'failed', deliveryId, invitations: invitationIds.length, message };
    }
  }

  /**
   * Retry (failed) or resend (sent) one delivery. Plaintext tokens are never stored, so every resend issues new
   * tokens for the delivery's still-unused invitations: links in earlier copies of the email stop working, and
   * a duplicate email can never lead to a duplicate review.
   */
  async resendDelivery(deliveryId: string, options: { userId: string | null; trigger: string; allowSent: boolean }): Promise<DeliveryOutcome> {
    const delivery = await this.repo(DELIVERIES).findOne({ filterByTk: deliveryId });
    if (!delivery) throw new ReviewError('not_found', 'Delivery not found.', 404);
    const status = delivery.get('status');
    if (status === 'skipped') throw new ReviewError('skipped', 'This delivery was skipped by the email policy; nothing can be resent.', 409);
    if (status === 'sent' && !options.allowSent) return { status: 'duplicate', deliveryId };
    const locked = status === 'sending' && delivery.get('lockedUntil') && new Date(delivery.get('lockedUntil')).getTime() > Date.now();
    if (locked) throw new ReviewError('in_progress', 'This email is being sent right now. Try again in a few minutes.', 409);

    const tokens = new Map<string, string>();
    const transaction = await this.db.sequelize.transaction();
    try {
      const rows = await this.model(INVITATIONS).findAll({ where: { deliveryId, usedAt: null, revokedAt: null }, transaction, lock: transaction.LOCK.UPDATE });
      for (const inv of rows) {
        if (await this.hasReview(inv.get('appointmentId'), inv.get('staffId'), transaction)) continue;
        const token = generateToken();
        await inv.update(
          {
            tokenHash: this.hash(token),
            activeKey: activeKeyOf(inv.get('appointmentId'), inv.get('staffId')),
            expiresAt: new Date(Date.now() + INVITATION_TTL_DAYS * DAY_MS),
            deliveryStatus: 'pending',
          },
          { transaction },
        );
        tokens.set(String(inv.get('id')), token);
      }
      if (!tokens.size) throw new ReviewError('nothing_to_send', 'Every invitation in this email was used or revoked.', 409);
      // Re-open the delivery so dispatch() can claim it (a sent delivery is re-opened only for an explicit resend).
      await this.model(DELIVERIES).update(
        { status: 'pending', lockedUntil: null, trigger: options.trigger, invitationCount: tokens.size },
        { where: { id: deliveryId }, transaction },
      );
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      if (isUnique(error)) throw new ReviewError('already_active', 'Another active invitation already exists for this technician.', 409);
      throw error;
    }
    return this.dispatch(deliveryId, tokens);
  }

  // ------------------------------------------------------------------ staff actions

  async sendNow(appointmentId: unknown, userId: unknown): Promise<DeliveryOutcome> {
    return this.sendForAppointment({ appointmentId, trigger: 'manual', idempotencyKey: `manual:${appointmentId}:${randomUUID()}`, userId });
  }

  async revokeInvitation(invitationId: unknown, userId: unknown, reason?: string) {
    const [count] = await this.model(INVITATIONS).update(
      { revokedAt: new Date(), activeKey: null, revokedReason: String(reason || 'Revoked by staff').slice(0, 200) },
      { where: { id: invitationId, usedAt: null, revokedAt: null } },
    );
    if (!count) throw new ReviewError('not_revocable', 'Only an unused invitation that is not already revoked can be revoked.', 409);
    this.app.logger.info('customer-reviews: invitation revoked', { invitationId: String(invitationId), userId: str(userId) });
    return { revoked: true };
  }

  /** New invitation (and email) replacing an expired or revoked one. Same eligibility and email policy as the workflow. */
  async regenerateInvitation(invitationId: unknown, userId: unknown): Promise<DeliveryOutcome> {
    const old = await this.repo(INVITATIONS).findOne({ filterByTk: invitationId as any });
    if (!old) throw new ReviewError('not_found', 'Invitation not found.', 404);
    const state = invitationState(old.toJSON());
    if (state === 'used') throw new ReviewError('used', 'This invitation was already used for a review.', 409);
    if (state === 'active') throw new ReviewError('active', 'This invitation is still active. Resend it instead.', 409);
    return this.sendForAppointment({
      appointmentId: old.get('appointmentId'),
      trigger: 'regenerate',
      idempotencyKey: `regenerate:${invitationId}:${randomUUID()}`,
      userId,
    });
  }

  /**
   * Manual fallback: a link for staff to hand to the customer in person (nothing is sent). Replaces any active
   * invitation for that technician. The URL is returned once, to the authorized staff member, and never stored.
   */
  async createManualLink(appointmentId: unknown, staffId: unknown, userId: unknown) {
    const appointment = await this.loadAppointment(appointmentId);
    if (!appointment || !isReviewableAppointment(appointment)) throw new ReviewError('ineligible', SKIP_MESSAGES.appointment_ineligible, 409);
    if (appointment.customer?.status === 'blocked') throw new ReviewError('customer_blocked', SKIP_MESSAGES.customer_blocked, 409);
    const tech = (await this.eligibleTechnicians(appointment)).find((t) => t.staffId === String(staffId));
    if (!tech) throw new ReviewError('not_technician', 'That staff member did not perform this appointment.', 409);
    if (await this.hasReview(appointment.id, tech.staffId)) throw new ReviewError('reviewed', 'This technician has already been reviewed for this appointment.', 409);

    const token = generateToken();
    const expiresAt = new Date(Date.now() + INVITATION_TTL_DAYS * DAY_MS);
    const transaction = await this.db.sequelize.transaction();
    try {
      const active = await this.activeInvitation(appointment.id, tech.staffId, transaction);
      if (active) await this.retire(active.id, 'Replaced by a manual link', transaction);
      await this.repo(INVITATIONS).create({
        values: {
          appointmentId: appointment.id,
          customerId: appointment.customerId,
          staffId: tech.staffId,
          tokenHash: this.hash(token),
          activeKey: activeKeyOf(appointment.id, tech.staffId),
          expiresAt,
          channel: 'manual',
          deliveryStatus: 'skipped',
          createdById: str(userId),
        },
        transaction,
      });
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      if (isUnique(error)) throw new ReviewError('already_active', 'Another invitation was created at the same moment. Refresh and try again.', 409);
      throw error;
    }
    const decision = emailDeliveryDecision(appointment.customer, await this.loadSuppressions(appointment.customerId));
    this.app.logger.info('customer-reviews: manual review link created', { appointmentId: String(appointment.id), staffId: tech.staffId, userId: str(userId) });
    return {
      url: reviewUrl(this.baseUrl(), token),
      technicianName: tech.name,
      expiresAt: expiresAt.toISOString(),
      emailAllowed: decision.allowed,
      emailNote: decision.allowed === false ? decision.message : null,
    };
  }

  /** Everything the appointment panel shows. Staff-only; never includes token hashes. */
  async appointmentSummary(appointmentId: unknown) {
    const appointment = await this.loadAppointment(appointmentId);
    if (!appointment) throw new ReviewError('not_found', 'Appointment not found.', 404);
    const decision = emailDeliveryDecision(appointment.customer, await this.loadSuppressions(appointment.customerId));
    const technicians = await this.eligibleTechnicians(appointment);
    const invitations = (
      await this.repo(INVITATIONS).find({ filter: { appointmentId: appointment.id }, sort: ['-createdAt'], except: ['tokenHash'] })
    ).map((r: any) => r.toJSON());
    const reviews = (await this.repo(REVIEWS).find({ filter: { appointmentId: appointment.id } })).map((r: any) => r.toJSON());
    const deliveries = (await this.repo(DELIVERIES).find({ filter: { appointmentId: appointment.id }, sort: ['-createdAt'], limit: 10 })).map((r: any) => r.toJSON());
    const now = Date.now();
    const shape = (inv: any) => ({
      id: String(inv.id),
      state: invitationState(inv, now),
      channel: inv.channel,
      deliveryStatus: inv.deliveryStatus,
      deliveryId: str(inv.deliveryId),
      createdAt: inv.createdAt,
      sentAt: inv.sentAt,
      expiresAt: inv.expiresAt,
      usedAt: inv.usedAt,
      revokedAt: inv.revokedAt,
      revokedReason: inv.revokedReason,
      sendAttempts: inv.sendAttempts,
      lastSendError: inv.lastSendError,
    });
    return {
      appointmentId: String(appointment.id),
      status: appointment.status,
      reviewable: isReviewableAppointment(appointment),
      email: decision.allowed === false ? { allowed: false, reason: decision.reason, message: decision.message } : { allowed: true },
      technicians: technicians.map((t) => {
        const review = reviews.find((r: any) => String(r.staffId) === t.staffId);
        return {
          staffId: t.staffId,
          name: t.name,
          review: review ? { rating: review.rating, comment: review.comment, status: review.status, submittedAt: review.submittedAt } : null,
          invitations: invitations.filter((inv: any) => String(inv.staffId) === t.staffId).map(shape),
        };
      }),
      deliveries: deliveries.map((d: any) => ({
        id: String(d.id),
        trigger: d.trigger,
        status: d.status,
        skipReason: d.skipReason,
        skipMessage: d.skipMessage,
        attempts: d.attempts,
        sentAt: d.sentAt,
        lastError: d.lastError,
        createdAt: d.createdAt,
        lockedUntil: d.lockedUntil,
      })),
    };
  }

  // ------------------------------------------------------------------ public (token) side

  private async findByToken(token: unknown, transaction?: any, lock = false) {
    if (!isWellFormedToken(token)) return null;
    return this.model(INVITATIONS).findOne({
      where: { tokenHash: this.hash(token) },
      transaction,
      ...(lock && transaction ? { lock: transaction.LOCK.UPDATE } : {}),
    });
  }

  /** Why an invitation cannot be used right now, or null if it can. Checks the appointment, not just the link. */
  private async usability(invitation: any, transaction?: any): Promise<{ state: PublicState; appointment?: any }> {
    if (!invitation) return { state: 'invalid' };
    const values = invitation.toJSON ? invitation.toJSON() : invitation;
    const state = invitationState(values);
    if (state !== 'active') return { state };
    const appointment = await this.loadAppointment(values.appointmentId, transaction);
    if (!appointment || !isReviewableAppointment(appointment)) return { state: 'ineligible' };
    if (String(appointment.customerId) !== String(values.customerId)) return { state: 'ineligible' };
    if (!technicianIds(appointment).includes(String(values.staffId))) return { state: 'ineligible' };
    if (await this.hasReview(values.appointmentId, values.staffId, transaction)) return { state: 'used' };
    return { state: 'valid', appointment };
  }

  /** What the review page may show: technician name, services and date only. No customer data, no ids. */
  async inspect(token: unknown) {
    const invitation = await this.findByToken(token);
    const { state, appointment } = await this.usability(invitation);
    if (state !== 'valid') return { state };
    const staff = await this.staffById([String(invitation.get('staffId'))]);
    return {
      state,
      technicianName: staffName(staff[String(invitation.get('staffId'))]),
      services: this.serviceNames(appointment),
      appointmentDate: appointment.appointmentDate || (appointment.startTime ? String(appointment.startTime).slice(0, 10) : null),
    };
  }

  /**
   * Creates the review and consumes the invitation in one transaction. The invitation row is locked (FOR UPDATE)
   * and consumed with a conditional update; the unique (appointmentId, staffId) and invitationId indexes are the
   * final guard. Customer, appointment and technician come from the invitation, never from the browser.
   */
  async submit(token: unknown, input: { rating?: unknown; comment?: unknown }) {
    const checked = validateSubmission(input);
    if (checked.ok === false) return { ok: false as const, state: 'valid' as PublicState, errors: checked.errors };

    const transaction: any = await this.db.sequelize.transaction();
    transaction[SUBMISSION_FLAG] = true;
    try {
      const invitation = await this.findByToken(token, transaction, true);
      const { state } = await this.usability(invitation, transaction);
      if (state !== 'valid') {
        await transaction.rollback();
        return { ok: false as const, state };
      }
      const now = new Date();
      const [consumed] = await this.model(INVITATIONS).update(
        { usedAt: now, activeKey: null },
        { where: { id: invitation.get('id'), usedAt: null, revokedAt: null }, transaction },
      );
      if (consumed !== 1) {
        await transaction.rollback();
        return { ok: false as const, state: 'used' as PublicState };
      }
      await this.repo(REVIEWS).create({
        values: {
          appointmentId: invitation.get('appointmentId'),
          customerId: invitation.get('customerId'),
          staffId: invitation.get('staffId'),
          invitationId: invitation.get('id'),
          rating: checked.value.rating,
          comment: checked.value.comment,
          status: 'submitted',
          submittedAt: now,
        },
        transaction,
      });
      await transaction.commit();
      this.app.logger.info('customer-reviews: review submitted', { invitationId: String(invitation.get('id')) });
      return { ok: true as const, state: 'submitted' };
    } catch (error) {
      await transaction.rollback();
      if (isUnique(error)) return { ok: false as const, state: 'used' as PublicState };
      throw error;
    }
  }

  // ------------------------------------------------------------------ moderation and statistics

  async moderate(reviewId: unknown, action: string, reason: unknown, userId: unknown) {
    if (!['flag', 'unflag'].includes(action)) throw new ReviewError('bad_action', 'Moderation action must be flag or unflag.');
    const note = typeof reason === 'string' ? reason.trim().slice(0, 1000) : '';
    if (action === 'flag' && !note) throw new ReviewError('reason_required', 'Please give a reason for flagging this review.');
    const transaction: any = await this.db.sequelize.transaction();
    transaction[MODERATION_FLAG] = true;
    try {
      const review = await this.model(REVIEWS).findOne({ where: { id: reviewId }, transaction, lock: transaction.LOCK.UPDATE });
      if (!review) throw new ReviewError('not_found', 'Review not found.', 404);
      const from = review.get('status');
      const to = action === 'flag' ? 'flagged' : 'submitted';
      if (from === to) throw new ReviewError('no_change', `The review is already ${to}.`, 409);
      await review.update({ status: to }, { transaction });
      await this.repo(MODERATION_EVENTS).create({
        values: { reviewId: review.get('id'), action, fromStatus: from, toStatus: to, reason: note || null, createdById: str(userId) },
        transaction,
      });
      await transaction.commit();
      return { status: to };
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  /**
   * Review list for the Customer Reviews page: filters, paging, newest first, with technician, customer and
   * appointment names looked up server-side (the review rows store plain ids) and the moderation audit trail.
   */
  async listReviews(params: { page?: unknown; pageSize?: unknown; staffId?: unknown; rating?: unknown; status?: unknown; from?: unknown; to?: unknown; q?: unknown }) {
    const page = Math.max(1, Math.floor(Number(params.page) || 1));
    const pageSize = Math.min(100, Math.max(1, Math.floor(Number(params.pageSize) || 20)));
    const and: any[] = [];
    const given = (v: unknown) => v !== undefined && v !== null && v !== '' && v !== 'all';
    if (given(params.staffId)) and.push({ staffId: String(params.staffId) });
    if (given(params.rating)) {
      const rating = Number(params.rating);
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new ReviewError('bad_rating', 'Rating filter must be 1 to 5.');
      and.push({ rating });
    }
    if (given(params.status)) {
      if (!['submitted', 'flagged'].includes(String(params.status))) throw new ReviewError('bad_status', 'Status filter must be submitted or flagged.');
      and.push({ status: String(params.status) });
    }
    for (const [key, op] of [['from', '$gte'], ['to', '$lte']] as const) {
      if (!given(params[key])) continue;
      const d = new Date(String(params[key]));
      if (Number.isNaN(d.getTime())) throw new ReviewError('bad_date', 'Invalid date filter.');
      and.push({ submittedAt: { [op]: d.toISOString() } });
    }
    if (typeof params.q === 'string' && params.q.trim()) and.push({ comment: { $includes: params.q.trim().slice(0, 200) } });
    const [rows, count] = await this.repo(REVIEWS).findAndCount({
      filter: and.length ? { $and: and } : {},
      sort: ['-submittedAt'],
      offset: (page - 1) * pageSize,
      limit: pageSize,
      appends: ['moderationEvents', 'moderationEvents.createdBy'],
    });
    const data = rows.map((r: any) => r.toJSON());
    const ids = (key: string): string[] => Array.from(new Set<string>(data.map((r: any) => String(r[key]))));
    const byId = async (collection: string, list: string[], fields: string[]) => {
      if (!list.length || !this.db.getCollection(collection)) return {};
      const found = await this.repo(collection).find({ filter: { id: { $in: list } }, fields });
      return Object.fromEntries(found.map((x: any) => [String(x.get('id')), x.toJSON()]));
    };
    const [customers, appointments] = await Promise.all([
      byId('customers', ids('customerId'), ['id', 'firstName', 'lastName']),
      byId('appointments', ids('appointmentId'), ['id', 'appointmentDate', 'startTime']),
    ]);
    const allStaff = (await this.repo('staff').find({ fields: ['id', 'firstName', 'lastName'], sort: ['firstName'] })).map((r: any) => r.toJSON());
    const staffMap = Object.fromEntries(allStaff.map((x: any) => [String(x.id), x]));
    const person = (x: any) => (x ? { firstName: x.firstName ?? null, lastName: x.lastName ?? null } : null);
    return {
      count,
      page,
      pageSize,
      staffOptions: allStaff.map((x: any) => ({ id: String(x.id), name: staffName(x) })),
      rows: data.map((r: any) => ({
        id: String(r.id),
        rating: r.rating,
        comment: r.comment,
        status: r.status,
        submittedAt: r.submittedAt,
        staff: person(staffMap[String(r.staffId)]),
        customer: person(customers[String(r.customerId)]),
        appointment: appointments[String(r.appointmentId)]
          ? { appointmentDate: appointments[String(r.appointmentId)].appointmentDate, startTime: appointments[String(r.appointmentId)].startTime }
          : null,
        moderationEvents: (r.moderationEvents || []).map((e: any) => ({
          id: String(e.id),
          action: e.action,
          reason: e.reason,
          createdAt: e.createdAt,
          createdBy: e.createdBy ? { nickname: e.createdBy.nickname, username: e.createdBy.username } : null,
        })),
      })),
    };
  }

  /** Per-technician averages for reviews submitted in [from, to). Aggregated server-side; no customer data returned. */
  async scores(params: { from?: unknown; to?: unknown; staffId?: unknown }) {
    const from = new Date(String(params.from || ''));
    const to = new Date(String(params.to || ''));
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) throw new ReviewError('bad_range', 'A valid date range is required.');
    const filter: any = { submittedAt: { $gte: from.toISOString(), $lt: to.toISOString() } };
    if (params.staffId !== undefined && params.staffId !== null && params.staffId !== '' && params.staffId !== 'all') filter.staffId = String(params.staffId);
    const rows = await this.repo(REVIEWS).find({ filter, fields: ['staffId', 'rating', 'status'], limit: 50000 });
    const by = aggregateScores(rows.map((r: any) => r.toJSON()));
    return { minRankable: MIN_RANKABLE_REVIEWS, staff: Object.values(by) };
  }
}
