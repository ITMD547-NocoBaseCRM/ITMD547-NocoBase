// Review eligibility and email delivery policy. Pure functions (no NocoBase imports), unit-tested.
//
// DELIVERY ELIGIBILITY POLICY (documented in docs/customer-reviews.md)
// A review invitation is a service-related feedback request about an appointment that already took place.
// It is not marketing, so marketing opt-in is NOT required. It is still a message the customer did not ask
// for, so the salon's own transactional-email preference decides:
//   1. The customer exists and is not `blocked`.
//   2. The customer has a usable email address.
//   3. `emailTransactionalOptIn` is true. False or empty means no automatic email. The policy never changes
//      the field; consent is only ever recorded by staff or the customer through the consent workflow.
//   4. No active suppression applies: `communication_suppressions` rows with active=true and liftedAt empty,
//      channel email or all, purpose transactional or all (an unsubscribe, bounce, complaint, withdrawal...).
// When any check fails the invitation email is skipped and the reason is recorded. Staff can still create a
// link and hand it over in person (manual fallback), which sends nothing.

export const COMMENT_MAX_LENGTH = 1000;
export const COMPLETED_STATUS = 'completed';

export type DeliveryDecision = { allowed: true } | { allowed: false; reason: SkipReason; message: string };

export type SkipReason =
  | 'customer_missing'
  | 'customer_blocked'
  | 'no_email'
  | 'transactional_opt_out'
  | 'suppressed'
  | 'appointment_ineligible'
  | 'no_technicians'
  | 'already_invited';

export const SKIP_MESSAGES: Record<SkipReason, string> = {
  customer_missing: 'The appointment has no customer.',
  customer_blocked: 'The customer is blocked.',
  no_email: 'The customer has no usable email address.',
  transactional_opt_out: 'The customer has not opted in to transactional email.',
  suppressed: 'An active email suppression (unsubscribe, bounce, complaint or withdrawal) applies to this customer.',
  appointment_ineligible: 'The appointment is not completed.',
  no_technicians: 'No technician performed a service on this appointment.',
  already_invited: 'Every technician on this appointment already has an active invitation or a review.',
};

const EMAIL_PATTERN = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;

export function isUsableEmail(email: unknown): boolean {
  if (typeof email !== 'string') return false;
  const value = email.trim();
  return value.length > 0 && value.length <= 254 && EMAIL_PATTERN.test(value);
}

export type SuppressionLike = { active?: boolean | null; liftedAt?: unknown; channel?: string | null; purpose?: string | null };

export function suppressionApplies(s: SuppressionLike): boolean {
  if (!s || s.active !== true || (s.liftedAt !== null && s.liftedAt !== undefined && s.liftedAt !== '')) return false;
  const channelOk = s.channel === 'email' || s.channel === 'all';
  const purposeOk = s.purpose === 'transactional' || s.purpose === 'all';
  return channelOk && purposeOk;
}

export type CustomerLike = { status?: string | null; email?: string | null; emailTransactionalOptIn?: boolean | null };

export function emailDeliveryDecision(customer: CustomerLike | null | undefined, suppressions: SuppressionLike[] = []): DeliveryDecision {
  const deny = (reason: SkipReason): DeliveryDecision => ({ allowed: false, reason, message: SKIP_MESSAGES[reason] });
  if (!customer) return deny('customer_missing');
  if (customer.status === 'blocked') return deny('customer_blocked');
  if (!isUsableEmail(customer.email)) return deny('no_email');
  if (customer.emailTransactionalOptIn !== true) return deny('transactional_opt_out');
  if (suppressions.some(suppressionApplies)) return deny('suppressed');
  return { allowed: true };
}

export type AppointmentLike = {
  id?: unknown;
  status?: string | null;
  category?: string | null;
  customerId?: unknown;
  staffId?: unknown;
  appointmentServices?: Array<{ staffId?: unknown }> | null;
};

/** An appointment can be reviewed only while it is a completed client session with a customer. */
export function isReviewableAppointment(appointment: AppointmentLike | null | undefined): boolean {
  if (!appointment || appointment.id === null || appointment.id === undefined) return false;
  if (appointment.status !== COMPLETED_STATUS) return false;
  if (appointment.category && appointment.category !== 'session') return false;
  return appointment.customerId !== null && appointment.customerId !== undefined && appointment.customerId !== '';
}

const idOf = (value: unknown): string | null => (value === null || value === undefined || value === '' ? null : String(value));

/**
 * Technicians who performed the appointment's services, deduplicated. Today every appointment has exactly one
 * technician (appointments.staffId). If service lines ever get their own staffId, those technicians count too.
 */
export function technicianIds(appointment: AppointmentLike | null | undefined): string[] {
  if (!appointment) return [];
  const ids = [idOf(appointment.staffId), ...(appointment.appointmentServices || []).map((line) => idOf(line && line.staffId))];
  return Array.from(new Set(ids.filter((id): id is string => id !== null)));
}

export type InvitationLike = { usedAt?: unknown; revokedAt?: unknown; expiresAt?: unknown };
export type InvitationState = 'active' | 'used' | 'revoked' | 'expired';

const present = (value: unknown) => value !== null && value !== undefined && value !== '';

export function invitationState(invitation: InvitationLike, now: number = Date.now()): InvitationState {
  if (present(invitation.usedAt)) return 'used';
  if (present(invitation.revokedAt)) return 'revoked';
  const expires = new Date(invitation.expiresAt as any).getTime();
  if (!Number.isFinite(expires) || expires <= now) return 'expired';
  return 'active';
}

/** Key that is unique among active invitations: one active invitation per appointment and technician. */
export function activeKeyOf(appointmentId: unknown, staffId: unknown): string {
  return `${String(appointmentId)}:${String(staffId)}`;
}

export type SubmissionValue = { rating: number; comment: string | null };
export type SubmissionResult = { ok: true; value: SubmissionValue } | { ok: false; errors: { rating?: string; comment?: string } };

/** Validates what the customer typed. Identity (customer, appointment, technician) never comes from the browser. */
export function validateSubmission(input: { rating?: unknown; comment?: unknown } | null | undefined): SubmissionResult {
  const errors: { rating?: string; comment?: string } = {};
  const raw = input ? input.rating : undefined;
  const rating = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\s*\d+\s*$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) errors.rating = 'Please choose a rating from 1 to 5 stars.';

  let comment: string | null = null;
  const rawComment = input ? input.comment : undefined;
  if (rawComment !== undefined && rawComment !== null) {
    if (typeof rawComment !== 'string') {
      errors.comment = 'The comment must be text.';
    } else {
      // Keep line breaks and tabs, drop other control characters, collapse long runs of blank lines.
      const cleaned = rawComment.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/\n{3,}/g, '\n\n').trim();
      if (cleaned.length > COMMENT_MAX_LENGTH) errors.comment = `Please keep your comment under ${COMMENT_MAX_LENGTH} characters.`;
      comment = cleaned.length ? cleaned : null;
    }
  }
  if (errors.rating || errors.comment) return { ok: false, errors };
  return { ok: true, value: { rating, comment } };
}

/**
 * Error text that is safe to store and show to staff: no URLs (they could carry a token), no long opaque
 * strings, no email addresses, one line, bounded length.
 */
export function sanitizeError(error: unknown): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : typeof error === 'string' ? error : 'Unknown error';
  return (
    raw
      .replace(/https?:\/\/\S+/gi, '[url]')
      .replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]')
      .replace(/[^\s@<>]+@[^\s@<>]+/g, '[email]')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 300) || 'Unknown error'
  );
}
