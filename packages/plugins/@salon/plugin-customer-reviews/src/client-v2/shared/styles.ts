/**
 * Review page styles. Scoped under `.bwr` so nothing leaks into the CRM. Same palette and type as the
 * BeautyWithin welcome page (@salon/plugin-welcome-page). Text colour pairs meet WCAG AA (4.5:1).
 * No web fonts or other third-party resources: a token-bearing page must not load anything external.
 */
export const reviewStyles = `
.bwr {
  --bwr-ink: #2b1d1a; --bwr-ink-soft: #5c4a45; --bwr-cream: #fbf7f3; --bwr-blush: #f3e3da; --bwr-sand: #e9d6c8;
  --bwr-accent: #8a4b3c; --bwr-accent-deep: #6e3a2e; --bwr-gold: #b07f45; --bwr-error: #a1260d; --bwr-ok: #2f6b3a;
  --bwr-serif: 'Iowan Old Style', 'Palatino Linotype', Palatino, 'Book Antiqua', Georgia, serif;
  --bwr-sans: system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  min-height: 100vh; display: flex; flex-direction: column; align-items: center;
  padding: 24px 12px 40px;
  background:
    radial-gradient(900px 500px at 85% -10%, var(--bwr-blush) 0%, transparent 60%),
    radial-gradient(700px 400px at -10% 110%, var(--bwr-sand) 0%, transparent 55%),
    var(--bwr-cream);
  color: var(--bwr-ink); font-family: var(--bwr-sans); line-height: 1.55; -webkit-font-smoothing: antialiased;
}
.bwr *, .bwr *::before, .bwr *::after { box-sizing: border-box; }
.bwr :focus-visible { outline: 3px solid var(--bwr-accent-deep); outline-offset: 3px; border-radius: 8px; }
.bwr-brand { font-family: var(--bwr-serif); font-size: 1.35rem; font-weight: 600; color: var(--bwr-accent-deep); margin: 0 0 16px; letter-spacing: 0.01em; }
.bwr-card {
  width: 100%; max-width: 520px; background: rgba(255,255,255,0.86); border-radius: 18px;
  box-shadow: 0 1px 2px rgba(43,29,26,0.06), 0 12px 32px rgba(110,58,46,0.10); padding: 24px 20px;
}
@media (min-width: 480px) { .bwr-card { padding: 32px 32px; } }
.bwr-title { font-family: var(--bwr-serif); font-weight: 600; font-size: clamp(1.5rem, 6vw, 2rem); line-height: 1.15; margin: 0 0 8px; }
.bwr-context { margin: 0 0 20px; color: var(--bwr-ink-soft); font-size: 0.98rem; overflow-wrap: anywhere; }
.bwr-context strong { color: var(--bwr-ink); }
.bwr-fieldset { border: 0; margin: 0 0 20px; padding: 0; min-width: 0; }
.bwr-legend { font-weight: 600; margin-bottom: 8px; padding: 0; }
.bwr-stars { display: flex; gap: 4px; flex-wrap: nowrap; }
.bwr-star-input { position: absolute; opacity: 0; width: 1px; height: 1px; margin: 0; pointer-events: none; }
.bwr-star {
  display: inline-flex; align-items: center; justify-content: center; width: 48px; height: 48px; border-radius: 12px;
  cursor: pointer; color: #b9a69d; transition: transform 0.08s ease, color 0.08s ease; flex: none;
}
@media (max-width: 340px) { .bwr-star { width: 44px; height: 44px; } }
.bwr-star svg { width: 34px; height: 34px; display: block; }
.bwr-star.is-on { color: var(--bwr-gold); }
.bwr-star:hover { transform: scale(1.06); }
.bwr-star-input:focus-visible + .bwr-star { outline: 3px solid var(--bwr-accent-deep); outline-offset: 2px; }
.bwr-rating-text { min-height: 1.4em; margin-top: 6px; font-size: 0.92rem; color: var(--bwr-ink-soft); }
.bwr-label { display: block; font-weight: 600; margin-bottom: 6px; }
.bwr-hint { font-weight: 400; color: var(--bwr-ink-soft); }
.bwr-textarea {
  width: 100%; min-height: 120px; resize: vertical; padding: 10px 12px; border-radius: 12px; font: inherit; color: inherit;
  border: 1px solid #c9b3a8; background: #fff;
}
.bwr-textarea[aria-invalid="true"] { border-color: var(--bwr-error); }
.bwr-counter { text-align: right; font-size: 0.85rem; color: var(--bwr-ink-soft); margin-top: 4px; }
.bwr-error { color: var(--bwr-error); font-size: 0.92rem; margin: 6px 0 0; }
.bwr-alert { border-radius: 12px; padding: 12px 14px; margin: 0 0 16px; background: #fdecea; color: var(--bwr-error); }
.bwr-button {
  width: 100%; min-height: 48px; border: 0; border-radius: 999px; background: var(--bwr-accent); color: #fff;
  font: inherit; font-weight: 600; font-size: 1.02rem; cursor: pointer; padding: 12px 20px;
  display: inline-flex; align-items: center; justify-content: center; gap: 10px;
}
.bwr-button:hover { background: var(--bwr-accent-deep); }
.bwr-button[disabled] { opacity: 0.75; cursor: progress; }
.bwr-spinner { width: 18px; height: 18px; border-radius: 50%; border: 2px solid rgba(255,255,255,0.45); border-top-color: #fff; animation: bwr-spin 0.8s linear infinite; }
@keyframes bwr-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .bwr-spinner { animation: none; } .bwr-star { transition: none; } }
.bwr-status { text-align: center; }
.bwr-status-icon { font-size: 2.4rem; line-height: 1; margin-bottom: 8px; color: var(--bwr-accent); }
.bwr-status p { color: var(--bwr-ink-soft); margin: 0 0 8px; }
.bwr-footer { margin-top: 18px; font-size: 0.82rem; color: var(--bwr-ink-soft); text-align: center; max-width: 520px; }
.bwr-sr { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
`;
