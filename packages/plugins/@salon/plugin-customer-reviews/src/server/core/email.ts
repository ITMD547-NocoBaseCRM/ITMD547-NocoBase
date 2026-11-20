// Review invitation email. Pure rendering (no NocoBase imports), unit-tested.
// Wording follows the T-05 template. No internal ids, no promotional content, every customer- or
// staff-provided value is HTML-escaped. The rendered email is never logged or stored: it carries the tokens.

export const EMAIL_SUBJECT = 'How was your BeautyWithin appointment?';

export type ReviewLink = { technicianName: string; url: string };

export function escapeHtml(value: unknown): string {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** One line, no control characters, bounded: names go into a plain-text email and a subject-free greeting. */
export function cleanName(value: unknown, fallback: string): string {
  const text = String(value === null || value === undefined ? '' : value)
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return text || fallback;
}

export function renderInvitationEmail(input: { customerName?: string | null; links: ReviewLink[] }) {
  const customerName = cleanName(input.customerName, 'there');
  const links = input.links.map((l) => ({ technicianName: cleanName(l.technicianName, 'your technician'), url: l.url }));
  const single = links.length === 1;
  const prompt = single ? 'Please take a moment to rate your technician:' : 'Please take a moment to rate each of your technicians:';

  const text = [
    `Hello ${customerName},`,
    '',
    'Thank you for visiting BeautyWithin!',
    '',
    'We hope you enjoyed your recent appointment.',
    '',
    'We would love to hear about your experience with our team.',
    '',
    prompt,
    '',
    ...links.map((l) => `${l.technicianName}: ${l.url}`),
    '',
    'Your feedback helps us improve our services and recognize our team members.',
    '',
    `${single ? 'This review link is' : 'These review links are'} private, can only be used once, and expire after 7 days.`,
    '',
    'Thank you for choosing BeautyWithin!',
    '',
    'Best regards,',
    'The BeautyWithin Team',
  ].join('\n');

  const p = (content: string) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#2b1d1a;">${content}</p>`;
  const button = (l: ReviewLink) =>
    `<tr><td style="padding:6px 0;">` +
    `<a href="${escapeHtml(l.url)}" style="display:inline-block;padding:11px 20px;border-radius:999px;background:#8a4b3c;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;">` +
    `Rate ${escapeHtml(l.technicianName)}</a></td></tr>`;

  const html =
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="referrer" content="no-referrer"><title>${escapeHtml(EMAIL_SUBJECT)}</title></head>` +
    `<body style="margin:0;padding:0;background:#fbf7f3;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fbf7f3;"><tr><td align="center" style="padding:24px 12px;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;font-family:system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;">` +
    `<tr><td style="padding:28px 28px 8px;font-family:Georgia,'Palatino Linotype',serif;font-size:22px;font-weight:600;color:#6e3a2e;">BeautyWithin</td></tr>` +
    `<tr><td style="padding:8px 28px 24px;">` +
    p(`Hello ${escapeHtml(customerName)},`) +
    p('Thank you for visiting BeautyWithin!') +
    p('We hope you enjoyed your recent appointment.') +
    p('We would love to hear about your experience with our team.') +
    p(escapeHtml(prompt)) +
    `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 14px;">${links.map(button).join('')}</table>` +
    p('Your feedback helps us improve our services and recognize our team members.') +
    `<p style="margin:0 0 14px;font-size:13px;line-height:1.6;color:#5c4a45;">${single ? 'This review link is' : 'These review links are'} private, can only be used once, and expire after 7 days.</p>` +
    p('Thank you for choosing BeautyWithin!') +
    p('Best regards,<br>The BeautyWithin Team') +
    `</td></tr></table></td></tr></table></body></html>`;

  return { subject: EMAIL_SUBJECT, text, html };
}
