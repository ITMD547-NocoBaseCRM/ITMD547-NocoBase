import React, { useEffect, useId, useRef, useState } from 'react';
import { reviewStyles } from './styles';

/**
 * Public customer review page (/review#t=<token>). No sign-in.
 *
 * - The token is read from the URL fragment, which browsers never send to a server or in a Referer header.
 * - It is sent to the API only in the X-Review-Token header (headers are not written to the request log).
 * - Plain fetch, not the NocoBase API client: no staff credentials are attached even if a staff member opens
 *   a customer's link in a signed-in browser, and a 401 never redirects to the sign-in page.
 * - The page loads no third-party resources and sets `referrer: no-referrer`.
 *
 * Accessibility: the rating is a native radio group (arrow keys, screen readers announce "3 stars, 3 of 5"),
 * errors are linked with aria-describedby and announced via role="alert", status changes go to a live region.
 */

type PageState =
  | { kind: 'loading' }
  | { kind: 'form'; technicianName: string; services: string[]; appointmentDate: string | null }
  | { kind: 'done' }
  | { kind: 'closed'; state: string }
  | { kind: 'error'; message: string };

const LABELS = ['', 'Poor', 'Fair', 'Good', 'Very good', 'Excellent'];
const COMMENT_MAX = 1000;

const CLOSED: Record<string, { title: string; body: string }> = {
  invalid: { title: 'This link is not valid', body: 'Please check that you opened the complete link from your email. If it still does not work, contact BeautyWithin.' },
  expired: { title: 'This link has expired', body: 'Review links are valid for 7 days. Contact BeautyWithin if you would still like to share your feedback.' },
  revoked: { title: 'This link is no longer active', body: 'It was replaced or withdrawn. If you received a newer email from us, please use the link in that email.' },
  used: { title: 'Thank you, your review is already in', body: 'Each link can be used once, and a review has already been submitted with this one.' },
  ineligible: { title: 'This appointment cannot be reviewed', body: 'The appointment is no longer open for reviews. Contact BeautyWithin if you think this is a mistake.' },
};

export function readTokenFromHash(hash: string): string {
  const params = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  return params.get('t') || '';
}

function formatDate(value: string | null): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}/.test(value)) return null;
  const [y, m, d] = value.slice(0, 10).split('-').map(Number);
  try {
    return new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d)));
  } catch {
    return value.slice(0, 10);
  }
}

function useHeadPolicies() {
  useEffect(() => {
    const previousTitle = document.title;
    document.title = 'Rate your BeautyWithin appointment';
    const metas = [
      ['referrer', 'no-referrer'],
      ['robots', 'noindex, nofollow'],
    ].map(([name, content]) => {
      const meta = document.createElement('meta');
      meta.name = name;
      meta.content = content;
      document.head.appendChild(meta);
      return meta;
    });
    return () => {
      document.title = previousTitle;
      metas.forEach((m) => m.remove());
    };
  }, []);
}

const Star = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path fill="currentColor" d="M12 2.6l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.4l-5.9 3.3 1.3-6.6L2.5 9.5l6.6-.8z" />
  </svg>
);

export function ReviewPage({ apiBase }: { apiBase: string }) {
  useHeadPolicies();
  const base = (apiBase || '/api/').replace(/\/?$/, '/');
  const tokenRef = useRef(readTokenFromHash(typeof window !== 'undefined' ? window.location.hash : ''));
  const [page, setPage] = useState<PageState>({ kind: 'loading' });
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [comment, setComment] = useState('');
  const [errors, setErrors] = useState<{ rating?: string; comment?: string; form?: string }>({});
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const ids = { rating: useId(), comment: useId(), commentHelp: useId(), ratingText: useId() };

  const call = async (action: 'inspect' | 'submit', body?: Record<string, unknown>) => {
    const response = await fetch(`${base}customerReviewLinks:${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Review-Token': tokenRef.current },
      body: JSON.stringify(body || {}),
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    });
    if (response.status === 429) throw new Error('Too many attempts. Please wait a few minutes and try again.');
    if (!response.ok) throw new Error('Something went wrong on our side. Please try again in a moment.');
    const json = await response.json();
    return json && json.data !== undefined ? json.data : json;
  };

  useEffect(() => {
    if (!tokenRef.current) {
      setPage({ kind: 'closed', state: 'invalid' });
      return;
    }
    let active = true;
    call('inspect')
      .then((data) => {
        if (!active) return;
        if (data && data.state === 'valid') {
          setPage({ kind: 'form', technicianName: data.technicianName, services: data.services || [], appointmentDate: data.appointmentDate || null });
        } else {
          setPage({ kind: 'closed', state: (data && data.state) || 'invalid' });
        }
      })
      .catch((e) => active && setPage({ kind: 'error', message: e.message }));
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Move focus to the new heading whenever the page changes state, so screen readers announce it.
  useEffect(() => {
    if (page.kind !== 'loading' && page.kind !== 'form') headingRef.current?.focus();
  }, [page.kind]);

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (inFlight.current) return;
    const next: typeof errors = {};
    if (!rating) next.rating = 'Please choose a rating from 1 to 5 stars.';
    if (comment.trim().length > COMMENT_MAX) next.comment = `Please keep your comment under ${COMMENT_MAX} characters.`;
    setErrors(next);
    if (next.rating || next.comment) {
      document.getElementById(next.rating ? `${ids.rating}-1` : ids.comment)?.focus();
      return;
    }
    inFlight.current = true;
    setSubmitting(true);
    try {
      const data = await call('submit', { rating, comment: comment.trim() || null });
      if (data && data.ok) setPage({ kind: 'done' });
      else if (data && data.errors) setErrors(data.errors);
      else setPage({ kind: 'closed', state: (data && data.state) || 'invalid' });
    } catch (e: any) {
      setErrors({ form: e.message });
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  };

  const shown = hover || rating;
  let content: React.ReactNode;
  if (page.kind === 'loading') {
    content = (
      <div className="bwr-status" role="status" aria-live="polite">
        <p>Loading your review…</p>
      </div>
    );
  } else if (page.kind === 'done') {
    content = (
      <div className="bwr-status" role="status" aria-live="polite">
        <div className="bwr-status-icon" aria-hidden="true">✓</div>
        <h1 className="bwr-title" tabIndex={-1} ref={headingRef}>Thank you!</h1>
        <p>Your review has been submitted. Your feedback helps us improve our services and recognize our team members.</p>
        <p>You can close this page.</p>
      </div>
    );
  } else if (page.kind === 'closed') {
    const info = CLOSED[page.state] || CLOSED.invalid;
    content = (
      <div className="bwr-status">
        <h1 className="bwr-title" tabIndex={-1} ref={headingRef}>{info.title}</h1>
        <p>{info.body}</p>
      </div>
    );
  } else if (page.kind === 'error') {
    content = (
      <div className="bwr-status">
        <h1 className="bwr-title" tabIndex={-1} ref={headingRef}>We could not load this page</h1>
        <p>{page.message}</p>
      </div>
    );
  } else {
    const date = formatDate(page.appointmentDate);
    content = (
      <form onSubmit={onSubmit} noValidate aria-busy={submitting}>
        <h1 className="bwr-title">How was your experience?</h1>
        <p className="bwr-context">
          Rate <strong>{page.technicianName}</strong>
          {page.services.length ? <> for {page.services.join(', ')}</> : null}
          {date ? <> on {date}</> : null}.
        </p>
        {errors.form ? (
          <div className="bwr-alert" role="alert">
            {errors.form}
          </div>
        ) : null}
        <fieldset className="bwr-fieldset" aria-describedby={`${ids.ratingText}${errors.rating ? ` ${ids.rating}-error` : ''}`} aria-required="true">
          <legend className="bwr-legend">
            Your rating <span aria-hidden="true">*</span>
            <span className="bwr-sr"> (required)</span>
          </legend>
          <div className="bwr-stars" onMouseLeave={() => setHover(0)}>
            {[1, 2, 3, 4, 5].map((value) => (
              <React.Fragment key={value}>
                <input
                  className="bwr-star-input"
                  type="radio"
                  name="rating"
                  id={`${ids.rating}-${value}`}
                  value={value}
                  checked={rating === value}
                  disabled={submitting}
                  aria-invalid={errors.rating ? true : undefined}
                  onChange={() => {
                    setRating(value);
                    setErrors((e) => ({ ...e, rating: undefined }));
                  }}
                />
                <label
                  htmlFor={`${ids.rating}-${value}`}
                  className={`bwr-star${value <= shown ? ' is-on' : ''}`}
                  onMouseEnter={() => setHover(value)}
                  title={`${value} star${value > 1 ? 's' : ''}`}
                >
                  <Star />
                  <span className="bwr-sr">{`${value} star${value > 1 ? 's' : ''}, ${LABELS[value]}`}</span>
                </label>
              </React.Fragment>
            ))}
          </div>
          <div className="bwr-rating-text" id={ids.ratingText} aria-live="polite">
            {shown ? `${shown} of 5 stars: ${LABELS[shown]}` : 'Choose 1 to 5 stars.'}
          </div>
          {errors.rating ? (
            <p className="bwr-error" id={`${ids.rating}-error`} role="alert">
              {errors.rating}
            </p>
          ) : null}
        </fieldset>
        <div style={{ marginBottom: 20 }}>
          <label className="bwr-label" htmlFor={ids.comment}>
            Comments <span className="bwr-hint">(optional)</span>
          </label>
          <textarea
            className="bwr-textarea"
            id={ids.comment}
            value={comment}
            maxLength={COMMENT_MAX}
            disabled={submitting}
            aria-invalid={errors.comment ? true : undefined}
            aria-describedby={`${ids.commentHelp}${errors.comment ? ` ${ids.comment}-error` : ''}`}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Tell us what you enjoyed or what we could do better."
          />
          <div className="bwr-counter" id={ids.commentHelp}>
            {comment.length} / {COMMENT_MAX} characters
          </div>
          {errors.comment ? (
            <p className="bwr-error" id={`${ids.comment}-error`} role="alert">
              {errors.comment}
            </p>
          ) : null}
        </div>
        <button className="bwr-button" type="submit" disabled={submitting}>
          {submitting ? <span className="bwr-spinner" aria-hidden="true" /> : null}
          {submitting ? 'Submitting…' : 'Submit Review'}
        </button>
      </form>
    );
  }

  return (
    <main className="bwr">
      <style>{reviewStyles}</style>
      <p className="bwr-brand">BeautyWithin</p>
      <div className="bwr-card">{content}</div>
      <p className="bwr-footer">This private link can be used once and expires 7 days after it was sent.</p>
    </main>
  );
}

export default ReviewPage;
