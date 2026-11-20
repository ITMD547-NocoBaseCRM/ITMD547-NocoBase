// Unit tests for the pure review logic. No database or NocoBase needed.
// Run: yarn test:customer-reviews   (node --test with TypeScript type stripping, Node 22.18+)

import assert from 'node:assert/strict';
import test from 'node:test';
import { renderInvitationEmail, escapeHtml, EMAIL_SUBJECT } from '../core/email.ts';
import {
  activeKeyOf,
  COMMENT_MAX_LENGTH,
  emailDeliveryDecision,
  invitationState,
  isReviewableAppointment,
  isUsableEmail,
  sanitizeError,
  suppressionApplies,
  technicianIds,
  validateSubmission,
} from '../core/policy.ts';
import { FixedWindowLimiter } from '../core/rate-limit.ts';
import { aggregateScores, formatAverage } from '../core/scores.ts';
import { generateToken, hashToken, isWellFormedToken, reviewUrl, sameHash } from '../core/tokens.ts';

// ---------------------------------------------------------------- tokens
test('tokens carry 256 bits of randomness, URL-safe, and are unique', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 2000; i += 1) {
    const t = generateToken();
    assert.equal(t.length, 43);
    assert.equal(Buffer.from(t, 'base64url').length, 32);
    assert.match(t, /^[A-Za-z0-9_-]+$/);
    assert.ok(isWellFormedToken(t));
    seen.add(t);
  }
  assert.equal(seen.size, 2000);
});

test('only the hash is derived; HMAC depends on the secret and differs from the token', () => {
  const t = generateToken();
  const h1 = hashToken(t, 'secret-a');
  const h2 = hashToken(t, 'secret-b');
  assert.match(h1, /^[0-9a-f]{64}$/);
  assert.notEqual(h1, h2);
  assert.ok(!h1.includes(t));
  assert.equal(hashToken(t, 'secret-a'), h1);
  assert.ok(sameHash(h1, hashToken(t, 'secret-a')));
  assert.ok(!sameHash(h1, h2));
  assert.ok(!sameHash(h1, 'short'));
});

test('malformed tokens are rejected before any lookup', () => {
  for (const bad of ['', 'abc', 'x'.repeat(42), 'x'.repeat(44), 'a/b+c'.padEnd(43, 'x'), null, undefined, 42, {}]) {
    assert.equal(isWellFormedToken(bad as any), false, String(bad));
  }
});

test('review URLs put the token in the fragment, never in the path or query', () => {
  const url = reviewUrl('https://crm.example.com/', 'T'.repeat(43));
  assert.equal(url, `https://crm.example.com/review#t=${'T'.repeat(43)}`);
  const parsed = new URL(url);
  assert.equal(parsed.pathname, '/review');
  assert.equal(parsed.search, '');
});

// ---------------------------------------------------------------- delivery policy
const optedIn = { status: 'active', email: 'ana@example.com', emailTransactionalOptIn: true };

test('email policy: opted-in customer with a usable email is allowed', () => {
  assert.deepEqual(emailDeliveryDecision(optedIn, []), { allowed: true });
});

test('email policy: skips missing, blocked, no email, opt-out and unknown preference', () => {
  assert.equal((emailDeliveryDecision(null) as any).reason, 'customer_missing');
  assert.equal((emailDeliveryDecision({ ...optedIn, status: 'blocked' }) as any).reason, 'customer_blocked');
  assert.equal((emailDeliveryDecision({ ...optedIn, email: '' }) as any).reason, 'no_email');
  assert.equal((emailDeliveryDecision({ ...optedIn, email: 'not-an-email' }) as any).reason, 'no_email');
  assert.equal((emailDeliveryDecision({ ...optedIn, emailTransactionalOptIn: false }) as any).reason, 'transactional_opt_out');
  assert.equal((emailDeliveryDecision({ ...optedIn, emailTransactionalOptIn: null }) as any).reason, 'transactional_opt_out');
});

test('email policy: marketing opt-in is not required', () => {
  assert.deepEqual(emailDeliveryDecision({ ...optedIn, emailMarketingOptIn: false } as any), { allowed: true });
});

test('email policy: active email/transactional or all/all suppressions block; marketing, sms or lifted ones do not', () => {
  const sup = (o: any) => ({ active: true, liftedAt: null, channel: 'email', purpose: 'transactional', ...o });
  assert.ok(suppressionApplies(sup({})));
  assert.ok(suppressionApplies(sup({ channel: 'all', purpose: 'all' })));
  assert.ok(!suppressionApplies(sup({ purpose: 'marketing' })));
  assert.ok(!suppressionApplies(sup({ channel: 'sms' })));
  assert.ok(!suppressionApplies(sup({ active: false })));
  assert.ok(!suppressionApplies(sup({ liftedAt: '2026-11-01T00:00:00Z' })));
  assert.equal((emailDeliveryDecision(optedIn, [sup({ purpose: 'marketing' }), sup({ channel: 'all' })]) as any).reason, 'suppressed');
  assert.deepEqual(emailDeliveryDecision(optedIn, [sup({ purpose: 'marketing' })]), { allowed: true });
});

test('usable email check', () => {
  assert.ok(isUsableEmail(' ana@example.com '));
  for (const bad of ['', 'ana', 'ana@', '@example.com', 'ana@example', 'a b@example.com', null, 5]) assert.ok(!isUsableEmail(bad as any), String(bad));
});

// ---------------------------------------------------------------- eligibility
test('only completed client sessions with a customer are reviewable', () => {
  const base = { id: 1, status: 'completed', category: 'session', customerId: 7, staffId: 3 };
  assert.ok(isReviewableAppointment(base));
  assert.ok(isReviewableAppointment({ ...base, category: null }));
  for (const status of ['scheduled', 'confirmed', 'inProgress', 'cancelled', 'noShow']) assert.ok(!isReviewableAppointment({ ...base, status }), status);
  assert.ok(!isReviewableAppointment({ ...base, category: 'event' }));
  assert.ok(!isReviewableAppointment({ ...base, customerId: null }));
  assert.ok(!isReviewableAppointment(null));
});

test('technicians are deduplicated and unrelated lines are ignored', () => {
  assert.deepEqual(technicianIds({ staffId: 3 }), ['3']);
  assert.deepEqual(technicianIds({ staffId: null }), []);
  assert.deepEqual(technicianIds({ staffId: 3, appointmentServices: [{ staffId: 3 }, { staffId: 9 }, {}, { staffId: null }] }), ['3', '9']);
});

test('invitation states', () => {
  const now = Date.parse('2026-11-19T12:00:00Z');
  const future = '2026-11-26T12:00:00Z';
  assert.equal(invitationState({ expiresAt: future }, now), 'active');
  assert.equal(invitationState({ expiresAt: '2026-11-19T11:59:59Z' }, now), 'expired');
  assert.equal(invitationState({ expiresAt: future, revokedAt: '2026-11-19T10:00:00Z' }, now), 'revoked');
  assert.equal(invitationState({ expiresAt: future, usedAt: '2026-11-19T10:00:00Z', revokedAt: 'x' }, now), 'used');
  assert.equal(invitationState({ expiresAt: 'garbage' }, now), 'expired');
  assert.equal(activeKeyOf(10, '3'), '10:3');
});

// ---------------------------------------------------------------- submission validation
test('ratings 1 to 5 are accepted, everything else rejected', () => {
  for (const r of [1, 2, 3, 4, 5, '4']) assert.equal((validateSubmission({ rating: r }) as any).value.rating, Number(r));
  for (const r of [0, 6, -1, 3.5, '3.5', 'five', '', null, undefined, NaN, Infinity, [4], { v: 4 }]) {
    const res = validateSubmission({ rating: r });
    assert.equal(res.ok, false, String(r));
    assert.ok((res as any).errors.rating);
  }
});

test('comments are optional, trimmed, cleaned and length-limited', () => {
  assert.equal((validateSubmission({ rating: 5 }) as any).value.comment, null);
  assert.equal((validateSubmission({ rating: 5, comment: '   ' }) as any).value.comment, null);
  assert.equal((validateSubmission({ rating: 5, comment: ' Great\r\n\n\n\nwork\u0007 ' }) as any).value.comment, 'Great\n\nwork');
  assert.equal(validateSubmission({ rating: 5, comment: 'x'.repeat(COMMENT_MAX_LENGTH) }).ok, true);
  assert.equal(validateSubmission({ rating: 5, comment: 'x'.repeat(COMMENT_MAX_LENGTH + 1) }).ok, false);
  assert.equal(validateSubmission({ rating: 5, comment: 12 as any }).ok, false);
});

test('stored error text never contains URLs, tokens or email addresses', () => {
  const t = generateToken();
  const msg = sanitizeError(new Error(`Invalid login for ana@example.com while sending https://crm.example.com/review#t=${t} token ${t}`));
  assert.ok(!msg.includes(t));
  assert.ok(!msg.includes('ana@example.com'));
  assert.ok(!msg.includes('https://'));
  assert.ok(msg.length <= 300);
});

// ---------------------------------------------------------------- email
test('email follows the template, lists every technician link, escapes names and hides ids', () => {
  const links = [
    { technicianName: 'Grace <b>Kim</b>', url: 'https://crm.example.com/review#t=AAA' },
    { technicianName: 'Marcus Reed', url: 'https://crm.example.com/review#t=BBB' },
  ];
  const mail = renderInvitationEmail({ customerName: 'Ana "<script>"', links });
  assert.equal(mail.subject, EMAIL_SUBJECT);
  assert.equal(mail.subject, 'How was your BeautyWithin appointment?');
  for (const line of ['Thank you for visiting BeautyWithin!', 'We would love to hear about your experience with our team.', 'expire after 7 days', 'The BeautyWithin Team']) {
    assert.ok(mail.text.includes(line), line);
  }
  assert.ok(mail.text.includes('Grace <b>Kim</b>: https://crm.example.com/review#t=AAA'));
  assert.ok(mail.text.includes('Marcus Reed: https://crm.example.com/review#t=BBB'));
  assert.ok(mail.html.includes('Rate Grace &lt;b&gt;Kim&lt;/b&gt;'));
  assert.ok(mail.html.includes('Hello Ana &quot;&lt;script&gt;&quot;,'));
  assert.ok(!mail.html.includes('<script>'));
  assert.ok(mail.html.includes('href="https://crm.example.com/review#t=AAA"'));
  assert.ok(!/appointment\s*#?\d|customer\s*#?\d/i.test(mail.text));
  assert.equal(escapeHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
});

test('single-technician email uses singular wording; missing name falls back politely', () => {
  const mail = renderInvitationEmail({ customerName: '', links: [{ technicianName: '', url: 'https://x.test/review#t=A' }] });
  assert.ok(mail.text.startsWith('Hello there,'));
  assert.ok(mail.text.includes('Please take a moment to rate your technician:'));
  assert.ok(mail.text.includes('This review link is private'));
});

// ---------------------------------------------------------------- scores
test('average = sum / count, flagged and negative reviews count, junk ignored', () => {
  const by = aggregateScores([
    { staffId: 1, rating: 5, status: 'submitted' },
    { staffId: 1, rating: 4, status: 'submitted' },
    { staffId: 1, rating: 1, status: 'flagged' },
    { staffId: '2', rating: 3 },
    { staffId: 2, rating: 9 },
    { staffId: null, rating: 5 },
    { staffId: 2, rating: 4, status: 'deleted' },
  ]);
  assert.equal(by['1'].count, 3);
  assert.equal(by['1'].sum, 10);
  assert.equal(formatAverage(by['1'].average), '3.3');
  assert.deepEqual(by['1'].distribution, [1, 0, 0, 1, 1]);
  assert.equal(by['1'].flagged, 1);
  assert.equal(by['2'].count, 1);
  assert.equal(formatAverage(by['2'].average), '3.0');
  assert.ok(by['2'].lowSample);
  assert.equal(by['3'], undefined);
  assert.equal(formatAverage(null), null);
  assert.equal(formatAverage(4.25), '4.3');
  assert.equal(formatAverage(4.24), '4.2');
});

// ---------------------------------------------------------------- rate limiting
test('rate limiter allows the limit per window, then refuses until the window resets', () => {
  const rl = new FixedWindowLimiter(3, 60000, 100);
  const t0 = 1_000_000;
  assert.ok(rl.hit('ip', t0).allowed);
  assert.ok(rl.hit('ip', t0 + 1).allowed);
  assert.ok(rl.hit('ip', t0 + 2).allowed);
  const blocked = rl.hit('ip', t0 + 3);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSeconds >= 59);
  assert.ok(rl.hit('other', t0 + 3).allowed);
  assert.ok(rl.hit('ip', t0 + 60001).allowed);
});

test('rate limiter memory stays bounded', () => {
  const rl = new FixedWindowLimiter(1, 60000, 50);
  for (let i = 0; i < 1000; i += 1) rl.hit(`k${i}`, 1);
  assert.ok((rl as any).hits.size <= 50);
});
