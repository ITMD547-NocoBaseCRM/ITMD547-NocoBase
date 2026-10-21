/**
 * Styles for the welcome page. Every selector is scoped under `.swp` so nothing leaks into the CRM,
 * and no CSS tooling or third-party styling library is needed in either NocoBase client.
 *
 * Colour pairs used for text meet WCAG AA (4.5:1) against their backgrounds.
 */
export const welcomeStyles = `
.swp {
  --swp-ink: #2b1d1a;
  --swp-ink-soft: #5c4a45;
  --swp-cream: #fbf7f3;
  --swp-blush: #f3e3da;
  --swp-sand: #e9d6c8;
  --swp-accent: #8a4b3c;
  --swp-accent-deep: #6e3a2e;
  --swp-gold: #c39a6b;
  --swp-card: rgba(255, 255, 255, 0.72);
  --swp-radius: 18px;
  --swp-serif: 'Iowan Old Style', 'Palatino Linotype', Palatino, 'Book Antiqua', Georgia, serif;
  --swp-sans: system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;

  position: relative;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  overflow-x: hidden;
  background:
    radial-gradient(1200px 600px at 85% -10%, var(--swp-blush) 0%, transparent 60%),
    radial-gradient(900px 500px at -10% 110%, var(--swp-sand) 0%, transparent 55%),
    var(--swp-cream);
  color: var(--swp-ink);
  font-family: var(--swp-sans);
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
}
.swp *, .swp *::before, .swp *::after { box-sizing: border-box; }

.swp-skip {
  position: absolute; left: 16px; top: -48px; z-index: 10;
  padding: 10px 16px; border-radius: 10px;
  background: var(--swp-ink); color: var(--swp-cream); text-decoration: none; font-weight: 600;
  transition: top 0.2s ease;
}
.swp-skip:focus { top: 16px; }

.swp :focus-visible { outline: 3px solid var(--swp-gold); outline-offset: 3px; border-radius: 8px; }

/* Header */
.swp-header {
  width: 100%; max-width: 1180px; margin: 0 auto;
  padding: 28px 24px 0;
  display: flex; align-items: center; gap: 12px;
}
.swp-brand { display: inline-flex; align-items: center; gap: 12px; color: var(--swp-ink); text-decoration: none; }
/* The logo is a wide (408x298) circular mark with fine lines and small lettering: keep it large enough to read. */
.swp-brand-logo { display: block; height: 64px; width: auto; }
.swp-brand-name { font-family: var(--swp-serif); font-size: 1.35rem; font-weight: 600; letter-spacing: 0.01em; }

/* Hero */
.swp-main { flex: 1; width: 100%; }
.swp-hero {
  max-width: 1180px; margin: 0 auto; padding: 72px 24px 56px;
  display: grid; grid-template-columns: 1.15fr 0.85fr; align-items: center; gap: 56px;
}
.swp-eyebrow {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 6px 14px; border-radius: 999px;
  background: rgba(255, 255, 255, 0.7); box-shadow: inset 0 0 0 1px rgba(138, 75, 60, 0.18);
  color: var(--swp-accent-deep); font-size: 0.8rem; font-weight: 600; letter-spacing: 0.12em; text-transform: uppercase;
}
.swp-title {
  margin: 22px 0 12px;
  font-family: var(--swp-serif); font-weight: 600;
  font-size: clamp(2.4rem, 5.2vw, 4.1rem); line-height: 1.08; letter-spacing: -0.015em;
}
.swp-title-accent { color: var(--swp-accent); font-style: italic; }
.swp-subtitle { margin: 0 0 14px; font-size: clamp(1.1rem, 2vw, 1.35rem); color: var(--swp-ink); font-weight: 500; }
.swp-description { margin: 0 0 32px; max-width: 34rem; color: var(--swp-ink-soft); font-size: 1.02rem; }

.swp-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 16px 20px; }
.swp-cta {
  display: inline-flex; align-items: center; justify-content: center; gap: 10px;
  min-height: 52px; padding: 0 30px; border-radius: 999px;
  background: var(--swp-ink); color: var(--swp-cream);
  font-size: 1.02rem; font-weight: 600; letter-spacing: 0.02em; text-decoration: none;
  box-shadow: 0 10px 24px rgba(43, 29, 26, 0.22);
  transition: transform 0.25s ease, box-shadow 0.25s ease, background-color 0.25s ease;
}
.swp-cta:hover { background: var(--swp-accent-deep); color: #ffffff; transform: translateY(-2px); box-shadow: 0 14px 30px rgba(110, 58, 46, 0.3); }
.swp-cta:active { transform: translateY(0); }
.swp-cta-arrow { transition: transform 0.25s ease; }
.swp-cta:hover .swp-cta-arrow { transform: translateX(4px); }
.swp-note { display: inline-flex; align-items: center; gap: 8px; color: var(--swp-ink-soft); font-size: 0.92rem; }

/* Decorative visual */
.swp-visual { position: relative; aspect-ratio: 1 / 1; max-width: 440px; width: 100%; justify-self: center; }
.swp-orb {
  position: absolute; border-radius: 50%; filter: blur(0.5px);
  animation: swp-float 9s ease-in-out infinite;
}
.swp-orb-1 { inset: 6% 10% 14% 6%; background: radial-gradient(circle at 30% 30%, #ffffff 0%, var(--swp-blush) 45%, var(--swp-sand) 100%); box-shadow: 0 30px 60px rgba(110, 58, 46, 0.18); }
.swp-orb-2 { width: 34%; height: 34%; right: 0; top: 4%; background: radial-gradient(circle at 35% 35%, #fff6ef, var(--swp-gold)); opacity: 0.55; animation-delay: -3s; }
.swp-orb-3 { width: 22%; height: 22%; left: 2%; bottom: 6%; background: radial-gradient(circle at 35% 35%, #ffffff, #e4c9bb); opacity: 0.8; animation-delay: -6s; }
.swp-logo { position: absolute; inset: 6% 10% 14% 6%; display: grid; place-items: center; }
.swp-logo img { width: 78%; height: auto; }

/* Features */
.swp-features { max-width: 1180px; margin: 0 auto; padding: 8px 24px 72px; }
.swp-features-title { margin: 0 0 24px; font-family: var(--swp-serif); font-size: clamp(1.5rem, 2.6vw, 1.9rem); font-weight: 600; }
.swp-grid { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 18px; }
.swp-card {
  height: 100%; padding: 22px 22px 20px; border-radius: var(--swp-radius);
  background: var(--swp-card); backdrop-filter: blur(6px);
  box-shadow: 0 1px 0 rgba(255, 255, 255, 0.8) inset, 0 0 0 1px rgba(138, 75, 60, 0.1), 0 8px 24px rgba(43, 29, 26, 0.06);
  transition: transform 0.25s ease, box-shadow 0.25s ease;
}
.swp-card:hover { transform: translateY(-4px); box-shadow: 0 0 0 1px rgba(138, 75, 60, 0.18), 0 16px 34px rgba(43, 29, 26, 0.1); }
.swp-card-icon {
  width: 42px; height: 42px; border-radius: 12px; display: grid; place-items: center; margin-bottom: 14px;
  background: var(--swp-blush); color: var(--swp-accent-deep);
}
.swp-card-title { margin: 0 0 6px; font-size: 1.05rem; font-weight: 650; }
.swp-card-text { margin: 0; color: var(--swp-ink-soft); font-size: 0.95rem; }

/* Footer */
.swp-footer {
  max-width: 1180px; width: 100%; margin: 0 auto; padding: 24px;
  display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px;
  border-top: 1px solid rgba(138, 75, 60, 0.14);
  color: var(--swp-ink-soft); font-size: 0.88rem;
}

/* Session check */
.swp-checking { min-height: 100vh; display: grid; place-items: center; background: var(--swp-cream); color: var(--swp-ink-soft); font-family: var(--swp-sans); }
.swp-spinner { width: 34px; height: 34px; margin: 0 auto 12px; border-radius: 50%; border: 3px solid var(--swp-sand); border-top-color: var(--swp-accent); animation: swp-spin 0.9s linear infinite; }

/* Entrance animation */
.swp-reveal { opacity: 0; transform: translateY(14px); animation: swp-rise 0.7s cubic-bezier(0.2, 0.7, 0.2, 1) forwards; }
.swp-delay-1 { animation-delay: 0.08s; }
.swp-delay-2 { animation-delay: 0.16s; }
.swp-delay-3 { animation-delay: 0.24s; }
.swp-delay-4 { animation-delay: 0.32s; }

@keyframes swp-rise { to { opacity: 1; transform: none; } }
@keyframes swp-float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-10px); } }
@keyframes swp-spin { to { transform: rotate(360deg); } }

/* Tablet */
@media (max-width: 960px) {
  .swp-hero { grid-template-columns: 1fr; padding-top: 48px; gap: 36px; text-align: center; }
  .swp-description { margin-left: auto; margin-right: auto; }
  .swp-actions { justify-content: center; }
  .swp-visual { max-width: 300px; order: -1; }
  .swp-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
/* Phone */
@media (max-width: 560px) {
  .swp-header { padding: 20px 16px 0; }
  .swp-brand-logo { height: 52px; }
  .swp-hero { padding: 28px 16px 36px; }
  .swp-visual { max-width: 200px; }
  .swp-features { padding: 0 16px 48px; }
  .swp-grid { grid-template-columns: 1fr; }
  .swp-cta { width: 100%; }
  .swp-footer { padding: 20px 16px; justify-content: center; text-align: center; }
}

@media (prefers-reduced-motion: reduce) {
  .swp *, .swp *::before, .swp *::after, .swp-spinner {
    animation-duration: 0.001ms !important; animation-iteration-count: 1 !important; transition-duration: 0.001ms !important;
  }
  .swp-reveal { opacity: 1; transform: none; }
}
`;
