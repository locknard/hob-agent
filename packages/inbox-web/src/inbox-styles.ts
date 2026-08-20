/** Same-origin stylesheet for the authenticated, script-free household Inbox. */
export const INBOX_CSS = String.raw`
:root {
  color-scheme: light;
  --color-canvas: oklch(97.5% 0.008 145);
  --color-surface: oklch(99.2% 0.004 145);
  --color-surface-muted: oklch(95% 0.012 145);
  --color-ink: oklch(25% 0.025 242);
  --color-ink-muted: oklch(48% 0.022 242);
  --color-rule: oklch(87% 0.014 145);
  --color-primary: oklch(55% 0.17 252);
  --color-primary-hover: oklch(48% 0.17 252);
  --color-verified: oklch(48% 0.09 145);
  --color-verified-soft: oklch(93% 0.045 145);
  --color-uncertain: oklch(60% 0.12 55);
  --color-uncertain-soft: oklch(94% 0.045 55);
  --color-danger: oklch(50% 0.14 25);
  --radius-sm: 0.4rem;
  --radius-md: 0.75rem;
  --space-xs: 0.25rem;
  --space-sm: 0.5rem;
  --space-md: 0.75rem;
  --space-lg: 1.5rem;
  --space-xl: 2rem;
  --space-2xl: 3rem;
  --focus-ring: oklch(62% 0.18 252 / 45%);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  font-synthesis: none;
}

* { box-sizing: border-box; }
html { background: var(--color-canvas); color: var(--color-ink); }
body { margin: 0; min-height: 100vh; background: var(--color-surface); font-size: 1rem; line-height: 1.5; }
a { color: inherit; }
button, select, textarea { font: inherit; }
button, select, textarea, a { -webkit-tap-highlight-color: transparent; }
:focus-visible { outline: 0.1875rem solid var(--focus-ring); outline-offset: 0.1875rem; }
.skip-link { position: fixed; inset-block-start: var(--space-sm); inset-inline-start: var(--space-sm); z-index: 500; transform: translateY(-160%); padding: var(--space-md) var(--space-lg); border-radius: var(--radius-sm); background: var(--color-ink); color: var(--color-surface); }
.skip-link:focus { transform: translateY(0); }

.app-shell { min-height: 100vh; }
.app-topbar { min-height: 4.25rem; display: flex; align-items: center; justify-content: space-between; gap: var(--space-lg); padding: var(--space-md) var(--space-lg); border-block-end: 1px solid var(--color-rule); background: var(--color-surface); }
.brand { min-height: 2.75rem; display: flex; align-items: center; gap: var(--space-md); text-decoration: none; }
.brand strong { font-size: 1.125rem; letter-spacing: -0.02em; }
.brand span, .topbar-note { color: var(--color-ink-muted); font-size: 0.875rem; }
.app-body { display: grid; grid-template-columns: 1fr; }
.app-nav { display: flex; gap: var(--space-xs); overflow-x: auto; padding: var(--space-sm) max(var(--space-md), env(safe-area-inset-right)) var(--space-sm) max(var(--space-md), env(safe-area-inset-left)); border-block-end: 1px solid var(--color-rule); background: var(--color-canvas); scrollbar-width: none; }
.app-nav a { min-height: 2.75rem; display: inline-flex; align-items: center; gap: var(--space-sm); flex: 0 0 auto; padding: var(--space-sm) var(--space-md); border-radius: var(--radius-sm); color: var(--color-ink-muted); text-decoration: none; font-size: 0.875rem; font-weight: 600; }
.app-nav a[aria-current="page"] { background: var(--color-verified-soft); color: var(--color-ink); }
.nav-mark { width: 1.5rem; height: 1.5rem; display: grid; place-items: center; border: 1px solid currentColor; border-radius: 50%; font-size: 0.6875rem; }
.app-content { min-width: 0; }

main { width: min(100%, 92rem); margin-inline: auto; padding: var(--space-lg) max(var(--space-lg), env(safe-area-inset-right)) calc(var(--space-2xl) + env(safe-area-inset-bottom)) max(var(--space-lg), env(safe-area-inset-left)); }
h1, h2, h3, p { margin-block-start: 0; }
h1 { max-width: 28ch; margin-block-end: var(--space-md); font-size: 2rem; line-height: 1.15; letter-spacing: -0.035em; text-wrap: balance; }
h2 { margin-block-end: var(--space-md); font-size: 1.25rem; line-height: 1.25; letter-spacing: -0.015em; }
h3 { margin-block-end: var(--space-sm); font-size: 1rem; line-height: 1.35; }
p { max-width: 68ch; }
.eyebrow { margin-block-end: var(--space-sm); color: var(--color-primary); font-size: 0.75rem; font-weight: 750; letter-spacing: 0.1em; text-transform: uppercase; }
.muted, .observation-status { color: var(--color-ink-muted); }
.page-header { padding-block: var(--space-md) var(--space-xl); border-block-end: 1px solid var(--color-rule); }

.inbox-overview { display: grid; gap: var(--space-lg); padding-block: var(--space-xl); }
.control-review { display: grid; gap: var(--space-lg); align-items: center; padding-block: var(--space-xl); border-block-end: 1px solid var(--color-rule); }
.control-review h2, .control-review p { margin-block-end: var(--space-sm); }
.control-review-link { min-height: 2.75rem; width: fit-content; display: inline-flex; align-items: center; padding: var(--space-sm) var(--space-lg); border-radius: var(--radius-sm); background: var(--color-primary); color: var(--color-surface); text-decoration: none; font-weight: 750; }
.control-review-link:hover { background: var(--color-primary-hover); }
.control-section { padding-block: var(--space-xl); border-block-end: 1px solid var(--color-rule); }
.control-service-list { margin: 0; padding: 0; list-style: none; border-block-start: 1px solid var(--color-rule); }
.control-service-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: var(--space-lg); align-items: start; padding-block: var(--space-lg); border-block-end: 1px solid var(--color-rule); }
.control-service-row h3, .control-service-row p { margin-block-end: var(--space-xs); }
.control-service-row .muted { font-size: 0.875rem; }
.control-diagnostics { border-block-end: 1px solid var(--color-rule); }
.control-diagnostics > summary { min-height: 2.75rem; display: flex; align-items: center; cursor: pointer; font-weight: 700; }
.control-diagnostics[open] > summary { margin-block-end: var(--space-lg); }
.control-diagnostics-body { padding-block-end: var(--space-xl); }
.control-technical-line { display: flex; flex-wrap: wrap; justify-content: space-between; gap: var(--space-md); padding-block: var(--space-md); border-block: 1px solid var(--color-rule); }
.control-technical-line span { color: var(--color-ink-muted); font-variant-numeric: tabular-nums; }
.control-list, .control-check-list { display: grid; gap: 0; margin: 0; padding: 0; list-style: none; border-block-start: 1px solid var(--color-rule); }
.control-list-item, .control-check-list li { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--space-md); padding: var(--space-md) 0; border-block-end: 1px solid var(--color-rule); }
.control-list-item > div:first-child { display: grid; gap: var(--space-xs); }
.control-list-item .muted { font-size: 0.875rem; }
.control-list-meta { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: var(--space-sm) var(--space-md); color: var(--color-ink-muted); font-size: 0.875rem; font-variant-numeric: tabular-nums; }
.control-empty { padding-block: var(--space-lg); color: var(--color-ink-muted); }
.control-note { border-block-end: 0; }
.observation-panel { display: grid; gap: var(--space-lg); align-items: start; padding-block-end: var(--space-xl); border-block-end: 1px solid var(--color-rule); }
.observation-panel form { align-self: center; }
.section-heading { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-lg); margin-block-end: var(--space-lg); }
.section-heading p { margin: 0; color: var(--color-ink-muted); }
.proposal-list, .observation-list, .evidence-ledger ul, .risk-list { margin: 0; padding: 0; list-style: none; }
.proposal-list { border-block-start: 1px solid var(--color-rule); }
.proposal-row { display: grid; gap: var(--space-md); padding-block: var(--space-lg); border-block-end: 1px solid var(--color-rule); }
.proposal-row a { width: fit-content; text-decoration: none; }
.proposal-row a:hover h2 { color: var(--color-primary); }
.proposal-row h2 { margin: 0; transition: color 180ms cubic-bezier(0.25, 1, 0.5, 1); }
.proposal-row p { margin: 0; color: var(--color-ink-muted); }
.proposal-meta, .metric-grid { display: flex; flex-wrap: wrap; gap: var(--space-md) var(--space-lg); margin: 0; }
.proposal-meta div, .metric-grid div { display: flex; gap: var(--space-sm); }
dt { color: var(--color-ink-muted); }
dd { margin: 0; font-variant-numeric: tabular-nums; font-weight: 650; }
.empty-state { padding-block: var(--space-2xl); border-block: 1px solid var(--color-rule); }
.quiet-section { padding-block: var(--space-xl); border-block-end: 1px solid var(--color-rule); }
.quiet-section summary, .agent-details summary { min-height: 2.75rem; display: flex; align-items: center; cursor: pointer; font-weight: 700; }
.quiet-section[open] summary, .agent-details[open] summary { margin-block-end: var(--space-lg); }
.observation-list li { padding: var(--space-md) 0; border-block-end: 1px solid var(--color-rule); color: var(--color-ink-muted); font-variant-numeric: tabular-nums; }
.advice-form { display: grid; gap: var(--space-md); max-width: 48rem; padding: var(--space-lg); border: 1px solid var(--color-rule); border-radius: var(--radius-md); background: var(--color-canvas); }
.advice-form p { margin: 0; color: var(--color-ink-muted); font-size: 0.875rem; }
.advice-list { display: grid; gap: 0; margin: 0; padding: 0; list-style: none; }
.advice-list li { display: grid; gap: var(--space-xs); padding-block: var(--space-md); border-block-end: 1px solid var(--color-rule); }
.advice-list a { width: fit-content; text-decoration: none; }
.advice-list span { color: var(--color-ink-muted); }

.back-link { min-height: 2.75rem; display: inline-flex; align-items: center; margin-block-end: var(--space-lg); color: var(--color-ink-muted); text-decoration: none; }
.proposal-detail > header { padding-block-end: var(--space-xl); border-block-end: 1px solid var(--color-rule); }
.status-line { display: flex; flex-wrap: wrap; gap: var(--space-sm) var(--space-lg); align-items: center; margin-block-start: var(--space-lg); }
.status-chip { display: inline-flex; align-items: center; min-height: 2rem; padding: var(--space-xs) var(--space-md); border-radius: 999px; background: var(--color-verified-soft); color: var(--color-verified); font-size: 0.875rem; font-weight: 700; }
.status-chip[data-status="attention"], .status-chip[data-status="busy"] { background: var(--color-uncertain-soft); color: var(--color-uncertain); }
.status-chip[data-status="unavailable"] { background: var(--color-surface-muted); color: var(--color-ink-muted); }
.review-columns { display: grid; gap: var(--space-xl); }
.proposal-case, .evidence-ledger { min-width: 0; }
.proposal-case > section, .evidence-ledger > section, .proposal-case > .review-decision { padding-block: var(--space-xl); border-block-end: 1px solid var(--color-rule); }
.uncertainty-list { padding-inline-start: 1.25rem; }
.uncertainty-list li::marker { color: var(--color-uncertain); }
.evidence-ledger > h2 { padding-block-start: var(--space-xl); }
.ledger-list { position: relative; }
.ledger-list::before { content: ""; position: absolute; inset-block: 0; inset-inline-start: 0.4375rem; width: 1px; background: var(--color-rule); }
.ledger-item { position: relative; display: grid; grid-template-columns: 1rem minmax(0, 1fr); gap: var(--space-md); padding-block: 0 var(--space-lg); }
.ledger-marker { z-index: 1; width: 0.9375rem; height: 0.9375rem; margin-block-start: 0.25rem; border: 0.1875rem solid var(--color-surface); border-radius: 50%; background: var(--color-verified); box-shadow: 0 0 0 1px var(--color-verified); }
.ledger-item[data-coverage="partial"] .ledger-marker, .ledger-item[data-coverage="unavailable"] .ledger-marker { background: var(--color-uncertain); box-shadow: 0 0 0 1px var(--color-uncertain); }
.ledger-item p { margin-block-end: var(--space-xs); }
.ledger-meta { color: var(--color-ink-muted); font-size: 0.875rem; font-variant-numeric: tabular-nums; }
.agent-details { margin-block: var(--space-xl); border-block: 1px solid var(--color-rule); }
.agent-loop-timeline { padding-block-end: var(--space-lg); }
.agent-loop-timeline ol, .agent-loop-timeline ul { padding-inline-start: 1.25rem; }
.advice-detail > header { padding-block-end: var(--space-xl); border-block-end: 1px solid var(--color-rule); }
.advice-detail > section { padding-block: var(--space-xl); border-block-end: 1px solid var(--color-rule); }
.advice-answer { max-width: 52rem; }
.advice-trial { padding: var(--space-lg); border-inline-start: 0.25rem solid var(--color-primary); background: var(--color-canvas); }
.hardware-suggestions { display: grid; gap: var(--space-lg); margin: 0; padding: 0; list-style: none; }
.hardware-suggestions > li { padding: var(--space-lg); border: 1px solid var(--color-rule); border-radius: var(--radius-md); background: var(--color-canvas); }
.hardware-suggestions p:last-child { margin-block-end: 0; }
.no-purchase-alternative { padding: var(--space-md); border-inline-start: 0.25rem solid var(--color-verified); background: var(--color-verified-soft); }

.review-boundary { padding: var(--space-lg); border: 1px solid var(--color-rule); border-radius: var(--radius-md); background: var(--color-canvas); }
.review-boundary > p:first-of-type { font-weight: 750; }
.review-forms { display: grid; gap: var(--space-lg); }
.review-forms form { display: grid; gap: var(--space-md); align-content: start; }
label { display: grid; gap: var(--space-sm); font-weight: 650; }
textarea, select { width: 100%; min-height: 2.75rem; padding: var(--space-md); border: 1px solid var(--color-rule); border-radius: var(--radius-sm); background: var(--color-surface); color: var(--color-ink); }
textarea { min-height: 6rem; resize: vertical; }
textarea:focus, select:focus { border-color: var(--color-primary); }
button { min-height: 2.75rem; width: fit-content; padding: var(--space-sm) var(--space-lg); border: 1px solid transparent; border-radius: var(--radius-sm); background: var(--color-primary); color: var(--color-surface); cursor: pointer; font-weight: 750; transition: background 180ms cubic-bezier(0.25, 1, 0.5, 1), transform 120ms cubic-bezier(0.25, 1, 0.5, 1); }
button:hover { background: var(--color-primary-hover); }
button:active { transform: translateY(1px); }
button:disabled { cursor: not-allowed; opacity: 0.52; }
.reject-button { border-color: var(--color-rule); background: var(--color-surface); color: var(--color-danger); }
.reject-button:hover { background: var(--color-uncertain-soft); }

@media (min-width: 44rem) {
  .observation-panel { grid-template-columns: minmax(0, 1fr) auto; }
  .proposal-row { grid-template-columns: minmax(0, 1fr) auto; align-items: center; }
  .proposal-meta { justify-content: flex-end; }
  .control-review { grid-template-columns: minmax(0, 1fr) auto; }
  .review-forms { grid-template-columns: 1fr 1fr; }
}

@media (min-width: 64rem) {
  .app-body { grid-template-columns: 15rem minmax(0, 1fr); }
  .app-nav { position: sticky; inset-block-start: 0; height: calc(100vh - 4.25rem); display: flex; flex-direction: column; overflow: auto; padding: var(--space-lg) var(--space-md); border-inline-end: 1px solid var(--color-rule); border-block-end: 0; }
  .app-nav a { width: 100%; }
  main { padding: var(--space-xl) var(--space-2xl) var(--space-2xl); }
  .review-columns { grid-template-columns: minmax(0, 5fr) minmax(22rem, 7fr); gap: 0; }
  .proposal-case { padding-inline-end: var(--space-2xl); }
  .evidence-ledger { padding-inline-start: var(--space-2xl); border-inline-start: 1px solid var(--color-rule); }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; transition-duration: 0.01ms !important; }
}
`;
