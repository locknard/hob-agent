/** Shared visual layer for the V4 product shell. The renderer owns semantics; this file owns only presentation. */
export const PRODUCT_SHELL_CSS = String.raw`
:root {
  color-scheme: light;
  --shell-bg: #f7f5f0;
  --shell-surface: #fffdf9;
  --shell-sidebar: #fbfaf7;
  --shell-ink: #16233a;
  --shell-muted: #6f7b8d;
  --shell-subtle: #94a0b0;
  --shell-rule: #e5e1d8;
  --shell-blue: #2e63e7;
  --shell-blue-soft: #edf2ff;
  --shell-green: #2e7d52;
  --shell-green-soft: #eaf5ef;
  --shell-amber: #b07818;
  --shell-amber-soft: #fff4df;
  --shell-red: #c0392b;
  --shell-red-soft: #fff0ed;
  --shell-purple: #6d5bd0;
  --shell-purple-soft: #f1efff;
  --shell-radius-lg: 22px;
  --shell-radius-md: 16px;
  --shell-radius-sm: 11px;
  --shell-shadow: 0 16px 40px rgba(24, 36, 58, 0.07);
  --shell-shadow-soft: 0 6px 18px rgba(24, 36, 58, 0.05);
  --shell-content-max: 1480px;
  --shell-motion: 180ms cubic-bezier(.25, 1, .5, 1);
  font: 100%/1.5 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", system-ui, sans-serif;
}

* { box-sizing: border-box; }
[hidden] { display: none !important; }
html { min-width: 320px; background: var(--shell-bg); }
body { min-width: 320px; margin: 0; background: var(--shell-bg); color: var(--shell-ink); }
button, input, select, textarea { font: inherit; }
button, a { -webkit-tap-highlight-color: transparent; }
button { cursor: pointer; }
button:disabled { cursor: not-allowed; opacity: .52; }
a { color: inherit; }
a:focus-visible, button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible, summary:focus-visible {
  outline: 3px solid color-mix(in srgb, var(--shell-blue) 68%, white);
  outline-offset: 3px;
}

.product-skip-link {
  position: fixed;
  z-index: 50;
  inset-block-start: .65rem;
  inset-inline-start: .65rem;
  transform: translateY(-180%);
  padding: .55rem .8rem;
  border-radius: var(--shell-radius-sm);
  background: var(--shell-ink);
  color: white;
  text-decoration: none;
  font-weight: 720;
}
.product-skip-link:focus { transform: translateY(0); }

.product-shell { min-height: 100svh; background: var(--shell-bg); }
.product-sr-only { position: absolute !important; width: 1px !important; height: 1px !important; padding: 0 !important; margin: -1px !important; overflow: hidden !important; clip: rect(0, 0, 0, 0) !important; white-space: nowrap !important; border: 0 !important; }
.product-layout { display: grid; grid-template-columns: minmax(13rem, 16rem) minmax(0, 1fr); min-height: 100svh; }
.product-sidebar {
  position: sticky;
  inset-block-start: 0;
  height: 100svh;
  display: flex;
  flex-direction: column;
  gap: 1.4rem;
  overflow: auto;
  padding: 1.4rem 1rem 1.1rem;
  border-inline-end: 1px solid var(--shell-rule);
  background: var(--shell-sidebar);
}
.product-brand { display: flex; align-items: center; gap: .7rem; min-height: 3.15rem; padding: .3rem .4rem; text-decoration: none; }
.product-brand-mark { width: 2.35rem; height: 2.35rem; display: grid; place-items: center; border-radius: .78rem; background: var(--shell-blue); color: white; font-family: Georgia, serif; font-size: 1.45rem; font-weight: 700; }
.product-brand-copy { display: grid; gap: .08rem; }
.product-brand-copy strong { font-size: 1.08rem; line-height: 1.1; }
.product-brand-copy small { color: var(--shell-subtle); font-size: .73rem; letter-spacing: .08em; }
.product-sidebar nav { display: grid; gap: .25rem; }
.product-nav-link { position: relative; display: flex; align-items: center; gap: .7rem; min-height: 3.05rem; padding: .65rem .75rem; border-radius: .95rem; color: var(--shell-ink); text-decoration: none; font-weight: 600; transition: background var(--shell-motion), color var(--shell-motion), transform var(--shell-motion); }
.product-nav-link:hover { background: var(--shell-blue-soft); color: var(--shell-blue); }
.product-nav-link:active { transform: scale(.985); }
.product-nav-link[aria-current="page"] { background: var(--shell-blue-soft); color: var(--shell-blue); font-weight: 760; }
.product-nav-icon { width: 1.35rem; color: var(--shell-muted); font-size: 1.15rem; line-height: 1; text-align: center; }
.product-nav-link[aria-current="page"] .product-nav-icon { color: var(--shell-blue); }
.product-nav-label { min-width: 0; flex: 1; }
.product-nav-badges { display: inline-flex; align-items: center; gap: .3rem; margin-inline-start: auto; }
.product-badge { min-width: 1.55rem; height: 1.55rem; display: inline-grid; place-items: center; padding-inline: .34rem; border-radius: 999px; font-size: .76rem; font-variant-numeric: tabular-nums; line-height: 1; }
.product-badge--runtime { background: var(--shell-amber-soft); color: var(--shell-amber); }
.product-badge--proposal { background: var(--shell-blue-soft); color: var(--shell-blue); }
.product-profile { display: flex; align-items: center; gap: .7rem; margin-block-start: auto; padding: 1rem .45rem .2rem; border-block-start: 1px solid var(--shell-rule); }
.product-profile-mark { width: 2.2rem; height: 2.2rem; display: grid; place-items: center; border-radius: 50%; background: var(--shell-green-soft); color: var(--shell-green); font-weight: 760; }
.product-profile-copy { display: grid; gap: .05rem; }
.product-profile-copy strong { font-size: .94rem; }
.product-profile-copy small { color: var(--shell-muted); font-size: .76rem; }

.product-content { min-width: 0; }
.product-mobile-header { display: none; }
.product-main { width: min(100%, var(--shell-content-max)); margin-inline: auto; padding: 2rem clamp(1.2rem, 3vw, 3rem) 3rem; }
.product-page-header { display: flex; align-items: end; justify-content: space-between; gap: 1.5rem; margin-block-end: 1.45rem; }
.product-page-header h1, .product-page-header h2, .product-page-header p { margin: 0; }
.product-page-header h1 { font-size: clamp(1.8rem, 3vw, 2.45rem); line-height: 1.12; letter-spacing: -.045em; text-wrap: balance; }
.product-page-header h2 { font-size: clamp(1.45rem, 2.2vw, 2rem); line-height: 1.16; letter-spacing: -.035em; text-wrap: balance; }
.product-kicker { margin-block-end: .3rem !important; color: var(--shell-muted); font-size: .8rem; font-weight: 760; letter-spacing: .08em; }
.product-muted { color: var(--shell-muted); }
.product-subtle { color: var(--shell-subtle); }
.product-connection { display: inline-flex; align-items: center; gap: .45rem; margin-block-start: .5rem !important; color: var(--shell-green); font-size: .92rem; font-weight: 650; }
.product-connection::before { content: ""; width: .56rem; height: .56rem; flex: 0 0 auto; border-radius: 50%; background: currentColor; }
.product-connection[data-connection-state="disconnected"], .product-connection[data-connection-state="connecting"] { color: var(--shell-amber); }
.product-connection[data-connection-state="disconnected"]::before { border-radius: .15rem; }
.product-connection[data-connection-state="unknown"] { color: var(--shell-muted); }
.product-view-switcher { display: inline-flex; align-items: center; gap: .35rem; min-height: 2.65rem; padding: .5rem .85rem; border: 1px solid var(--shell-rule); border-radius: 999px; background: var(--shell-surface); color: var(--shell-muted); text-decoration: none; font-weight: 650; }
.product-view-switcher:hover { border-color: var(--shell-blue); color: var(--shell-blue); }

.product-safety-banner { position: relative; z-index: 20; display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: .85rem max(1rem, env(safe-area-inset-right)) .85rem max(1rem, env(safe-area-inset-left)); background: var(--shell-red); color: white; }
.product-completion-notification { position: relative; z-index: 19; display: flex; align-items: center; justify-content: center; gap: 1rem; min-height: 2.75rem; padding: .65rem max(1rem, env(safe-area-inset-right)) .65rem max(1rem, env(safe-area-inset-left)); border-block-end: 1px solid var(--shell-rule); background: var(--shell-blue-soft); color: var(--shell-text); }
.product-completion-notification a { color: var(--shell-blue); font-weight: 650; }
.product-host-view-switcher { position: relative; z-index: 18; display: flex; align-items: center; justify-content: flex-end; gap: .8rem; min-height: 3rem; padding: .45rem max(1rem, env(safe-area-inset-right)) .45rem max(1rem, env(safe-area-inset-left)); border-block-end: 1px solid var(--shell-rule); background: var(--shell-surface); }
.product-host-view-switcher nav { display: inline-flex; gap: .2rem; padding: .2rem; border: 1px solid var(--shell-rule); border-radius: 999px; background: var(--shell-bg); }
.product-host-view-switcher a { min-height: 2rem; display: inline-flex; align-items: center; padding: .35rem .7rem; border-radius: 999px; color: var(--shell-muted); text-decoration: none; font-size: .82rem; font-weight: 700; }
.product-host-view-switcher a[aria-current="true"] { background: var(--shell-surface); color: var(--shell-blue); box-shadow: var(--shell-shadow-soft); }
.product-view-recovery { margin: 0; color: var(--shell-muted); font-size: .8rem; }
.product-safety-copy { display: grid; gap: .12rem; min-width: 0; }
.product-safety-copy strong { font-size: .96rem; }
.product-safety-copy span { color: rgba(255,255,255,.86); font-size: .83rem; }
.product-safety-meta { display: inline-flex; align-items: center; gap: .55rem; flex-wrap: wrap; justify-content: flex-end; }
.product-safety-source { color: rgba(255,255,255,.8); font-size: .78rem; }
.product-safety-action { min-height: 2.4rem; padding: .45rem .75rem; border: 1px solid rgba(255,255,255,.7); border-radius: 999px; background: transparent; color: white; font-weight: 720; }
.product-safety-action:hover { background: rgba(255,255,255,.12); }
.product-safety-acknowledge { margin: 0; }
.product-safety-acknowledge button { min-height: 2.4rem; padding: .45rem .75rem; border: 1px solid rgba(255,255,255,.7); border-radius: 999px; background: rgba(255,255,255,.14); color: white; font: inherit; font-weight: 720; cursor: pointer; }
.product-safety-acknowledge button:hover { background: rgba(255,255,255,.24); }

.product-card { min-width: 0; padding: 1.25rem; border: 1px solid var(--shell-rule); border-radius: var(--shell-radius-lg); background: var(--shell-surface); box-shadow: var(--shell-shadow-soft); }
.product-card h2, .product-card h3, .product-card p { margin-block-start: 0; }
.product-card h2 { margin-block-end: .8rem; font-size: 1.2rem; letter-spacing: -.025em; }
.product-card h3 { margin-block-end: .45rem; font-size: 1.02rem; }
.product-card p:last-child { margin-block-end: 0; }
.product-card--flat { box-shadow: none; }
.product-card--selected { border-color: var(--shell-blue); box-shadow: 0 0 0 1px var(--shell-blue), var(--shell-shadow-soft); }
.product-card--amber { background: #fffaf0; }
.product-card--blue { background: #f9fbff; }
.product-card--green { background: var(--shell-green-soft); border-color: color-mix(in srgb, var(--shell-green) 24%, var(--shell-rule)); }
.product-status-card { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin-block-end: 1.15rem; padding: 1rem 1.2rem; border: 1px solid var(--shell-rule); border-radius: var(--shell-radius-md); background: var(--shell-surface); }
.product-status-card p { margin: 0; }
.product-status-main { display: inline-flex; align-items: center; gap: .58rem; font-weight: 650; }
.product-status-mark { color: var(--shell-green); font-size: 1.1rem; }
.product-status-card[data-status="attention"] .product-status-mark { color: var(--shell-amber); }
.product-status-card[data-status="attention"] { background: var(--shell-amber-soft); }

.product-overview-grid { display: grid; grid-template-columns: minmax(0, 1.55fr) minmax(18rem, .85fr); gap: 1.2rem; align-items: start; }
.product-space-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1.2rem; }
.product-space-card { min-height: 10.8rem; }
.product-space-heading { display: flex; align-items: baseline; justify-content: space-between; gap: .65rem; margin-block-end: 1.05rem; }
.product-space-heading h2 { margin: 0; }
.product-space-meta { color: var(--shell-subtle); font-size: .86rem; white-space: nowrap; }
.product-metric-row { display: flex; flex-wrap: wrap; gap: .8rem 1.25rem; margin-block-end: 1.1rem; }
.product-metric { display: inline-flex; align-items: baseline; gap: .38rem; }
.product-metric-label { color: var(--shell-muted); font-size: .86rem; }
.product-metric-value { font-size: 1.25rem; font-weight: 760; letter-spacing: -.02em; font-variant-numeric: tabular-nums; }
.product-chip-row { display: flex; flex-wrap: wrap; gap: .5rem; }
.product-chip { display: inline-flex; align-items: center; min-height: 2.25rem; padding: .4rem .75rem; border: 1px solid var(--shell-rule); border-radius: 999px; color: var(--shell-muted); font-size: .88rem; text-decoration: none; }
.product-chip--active { border-color: var(--shell-blue); background: var(--shell-blue-soft); color: var(--shell-blue); }
.product-chip--verified { border-color: color-mix(in srgb, var(--shell-green) 24%, var(--shell-rule)); background: var(--shell-green-soft); color: var(--shell-green); }
.product-overview-aside { display: grid; gap: 1.2rem; }
.product-review-summary { display: grid; gap: .85rem; }
.product-review-summary h2 { display: flex; align-items: center; justify-content: space-between; gap: .6rem; }
.product-review-summary h2 a { color: var(--shell-blue); font-size: .82rem; font-weight: 650; text-decoration: none; white-space: nowrap; }
.product-summary-section { padding-block-start: .65rem; border-block-start: 1px dashed var(--shell-rule); }
.product-summary-heading { display: flex; align-items: center; gap: .45rem; margin-block-end: .55rem; font-size: .86rem; font-weight: 760; }
.product-summary-heading--amber { color: var(--shell-amber); }
.product-summary-heading--blue { color: var(--shell-blue); }
.product-summary-list { display: grid; gap: .35rem; margin: 0; padding: 0; list-style: none; }
.product-summary-list li { display: flex; justify-content: space-between; gap: .7rem; padding-block: .45rem; border-block-end: 1px dashed var(--shell-rule); font-size: .89rem; }
.product-summary-list li:last-child { border-block-end: 0; }
.product-summary-list span:last-child { color: var(--shell-muted); white-space: nowrap; }
.product-agent-note { display: grid; grid-template-columns: 2.2rem minmax(0, 1fr); gap: .7rem; align-items: start; }
.product-agent-mark { width: 2.2rem; height: 2.2rem; display: grid; place-items: center; border-radius: .7rem; background: var(--shell-blue); color: white; font-family: Georgia, serif; font-size: 1.25rem; }
.product-agent-bubble { padding: .7rem .8rem; border-radius: 1rem 1rem 1rem .3rem; background: var(--shell-blue-soft); color: var(--shell-ink); }
.product-energy-value { display: flex; align-items: baseline; gap: .7rem; }
.product-energy-value strong { font-size: 2.2rem; line-height: 1; letter-spacing: -.05em; }
.product-energy-value span { color: var(--shell-green); font-weight: 700; }
.product-energy-note { margin-block-start: .8rem; color: var(--shell-muted); font-size: .85rem; }
.product-composer { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: .65rem; align-items: center; margin-block-start: 1.3rem; padding: .55rem; border: 1px solid var(--shell-rule); border-radius: 999px; background: var(--shell-surface); box-shadow: var(--shell-shadow-soft); }
.product-composer input { min-width: 0; height: 2.65rem; padding-inline: .8rem; border: 0; outline: 0; background: transparent; color: var(--shell-ink); }
.product-composer input::placeholder { color: var(--shell-subtle); }
.product-composer button, .product-primary-action { min-height: 2.65rem; padding: .52rem 1rem; border: 0; border-radius: 999px; background: var(--shell-blue); color: white; font-weight: 760; transition: background var(--shell-motion), transform var(--shell-motion); }
.product-composer button:hover, .product-primary-action:hover { background: #2558d5; }
.product-composer button:active, .product-primary-action:active, .product-secondary-action:active, .product-nav-link:active, .product-mobile-nav-link:active { transform: scale(.98); }
.product-helper-copy { margin: .55rem .75rem 0; color: var(--shell-subtle); font-size: .8rem; }

.product-review-page { display: grid; grid-template-columns: minmax(18rem, 25rem) minmax(0, 1fr); gap: 1.3rem; align-items: start; }
.product-review-list { display: grid; gap: 1.1rem; }
.product-review-list-heading { display: flex; align-items: baseline; justify-content: space-between; gap: .8rem; }
.product-review-list-heading h2 { margin: 0; font-size: 1.25rem; }
.product-review-list-heading p { margin: 0; color: var(--shell-muted); font-size: .84rem; }
.product-review-card { display: grid; gap: .7rem; }
.product-review-card h3, .product-review-card p { margin: 0; }
.product-card-tags { display: flex; flex-wrap: wrap; gap: .4rem; }
.product-tag { display: inline-flex; align-items: center; min-height: 1.85rem; padding: .32rem .58rem; border-radius: .55rem; background: var(--shell-blue-soft); color: var(--shell-blue); font-size: .76rem; font-weight: 700; }
.product-tag--amber { background: var(--shell-amber-soft); color: var(--shell-amber); }
.product-tag--red { background: var(--shell-red-soft); color: var(--shell-red); }
.product-tag--green { background: var(--shell-green-soft); color: var(--shell-green); }
.product-review-card .product-card-actions { display: flex; flex-wrap: wrap; gap: .55rem; margin-block-start: .3rem; }
.product-primary-action, .product-secondary-action, .product-danger-action { display: inline-flex; align-items: center; justify-content: center; min-height: 2.7rem; padding: .55rem .95rem; border-radius: .8rem; font-weight: 740; text-decoration: none; }
.product-secondary-action { border: 1px solid var(--shell-rule); background: var(--shell-surface); color: var(--shell-ink); }
.product-secondary-action:hover { border-color: var(--shell-blue); color: var(--shell-blue); }
.product-danger-action { border: 1px solid color-mix(in srgb, var(--shell-red) 30%, var(--shell-rule)); background: var(--shell-surface); color: var(--shell-red); }
.product-review-empty { color: var(--shell-muted); }
.product-snooze { display: grid; gap: .55rem; padding-block-start: .55rem; border-block-start: 1px dashed var(--shell-rule); }
.product-snooze summary { color: var(--shell-muted); cursor: pointer; font-size: .83rem; font-weight: 700; }
.product-snooze-options { display: flex; flex-wrap: wrap; gap: .45rem; }
.product-snooze-options button { min-height: 2.35rem; padding: .45rem .7rem; border: 1px solid var(--shell-rule); border-radius: 999px; background: var(--shell-surface); color: var(--shell-ink); font-size: .8rem; }
.product-snooze-options button:hover { border-color: var(--shell-blue); color: var(--shell-blue); }
.product-snooze-note { margin: 0; color: var(--shell-subtle); font-size: .78rem; }
.product-proposal-detail { display: grid; gap: 1.2rem; }
.product-detail-header { display: flex; flex-wrap: wrap; align-items: start; justify-content: space-between; gap: .8rem; }
.product-detail-header h2 { margin: 0; font-size: clamp(1.5rem, 2.5vw, 2.1rem); }
.product-stepper { display: grid; grid-template-columns: repeat(3, 1fr); overflow: hidden; border: 1px solid var(--shell-rule); border-radius: var(--shell-radius-md); }
.product-step { display: flex; align-items: center; gap: .45rem; min-height: 3.3rem; padding: .55rem .7rem; border-inline-end: 1px solid var(--shell-rule); background: var(--shell-surface); color: var(--shell-muted); font-size: .82rem; }
.product-step:last-child { border-inline-end: 0; }
.product-step[data-state="current"] { border-color: var(--shell-blue); background: var(--shell-blue-soft); color: var(--shell-blue); font-weight: 760; }
.product-step[data-state="complete"] { color: var(--shell-green); }
.product-step-index { width: 1.55rem; height: 1.55rem; display: inline-grid; flex: 0 0 auto; place-items: center; border-radius: 50%; background: var(--shell-rule); font-size: .78rem; font-variant-numeric: tabular-nums; }
.product-step[data-state="current"] .product-step-index { background: var(--shell-blue); color: white; }
.product-step[data-state="complete"] .product-step-index { background: var(--shell-green-soft); color: var(--shell-green); }
.product-detail-columns { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; }
.product-detail-columns h3 { margin-block-end: .55rem; color: var(--shell-muted); font-size: .98rem; }
.product-detail-columns ul, .product-cause-chain { margin: 0; padding-inline-start: 1.1rem; }
.product-detail-columns li { margin-block: .45rem; }
.product-dependency { padding: .85rem 1rem; border-inline-start: .25rem solid var(--shell-amber); background: var(--shell-amber-soft); color: var(--shell-amber); }
.product-review-boundary { display: flex; flex-wrap: wrap; align-items: center; gap: .85rem; justify-content: space-between; padding-top: .4rem; }
.product-review-boundary p { margin: 0; color: var(--shell-muted); font-size: .84rem; }

.product-conversation { display: grid; grid-template-columns: minmax(0, 1fr) minmax(17rem, 22rem); gap: 1.3rem; align-items: stretch; }
.product-conversation-main { display: flex; min-height: 62svh; flex-direction: column; }
.product-conversation-header { margin-block-end: 1.2rem; }
.product-conversation-header h1 { margin-block-end: .25rem; }
.product-conversation-thread { display: grid; gap: 1rem; flex: 1; align-content: start; }
.product-message { display: grid; grid-template-columns: 2.2rem minmax(0, 1fr); gap: .7rem; align-items: start; }
.product-message--user { grid-template-columns: minmax(0, 1fr); justify-items: end; }
.product-message-mark { width: 2.2rem; height: 2.2rem; display: grid; place-items: center; border-radius: .7rem; background: var(--shell-blue); color: white; font-family: Georgia, serif; font-size: 1.25rem; }
.product-message-bubble { max-width: 70ch; padding: .85rem 1rem; border: 1px solid var(--shell-rule); border-radius: 1rem 1rem 1rem .3rem; background: var(--shell-surface); }
.product-message--user .product-message-bubble { border: 0; border-radius: 1rem 1rem .3rem 1rem; background: var(--shell-blue); color: white; }
.product-message-bubble p { margin: 0; }
.product-progress { display: grid; gap: .7rem; }
.product-progress-heading { display: flex; align-items: center; justify-content: space-between; gap: .7rem; }
.product-progress-heading h2 { margin: 0; font-size: 1rem; }
.product-progress-status { color: var(--shell-green); font-size: .83rem; font-weight: 740; }
.product-stage-list { display: grid; gap: .35rem; margin: 0; padding: 0; list-style: none; }
.product-stage-list li { display: flex; align-items: center; gap: .55rem; color: var(--shell-muted); font-size: .9rem; }
.product-stage-list li[data-state="current"] { color: var(--shell-ink); font-weight: 700; }
.product-stage-list li[data-state="complete"] { color: var(--shell-green); }
.product-stage-marker { width: 1.15rem; height: 1.15rem; display: inline-grid; flex: 0 0 auto; place-items: center; border: 1px solid var(--shell-rule); border-radius: 50%; font-size: .7rem; }
.product-stage-list li[data-state="current"] .product-stage-marker { border-color: var(--shell-blue); background: var(--shell-blue); color: white; }
.product-stage-list li[data-state="complete"] .product-stage-marker { border-color: var(--shell-green); color: var(--shell-green); }
.product-stream-text { min-height: 2rem; margin: .2rem 0 0; white-space: pre-wrap; }
.product-conversation-actions { display: flex; flex-wrap: wrap; gap: .55rem; margin-block-start: .3rem; }
.product-action-form { display: inline-flex; }
.product-action-form button { min-height: 2.55rem; padding: .48rem .82rem; border: 1px solid var(--shell-rule); border-radius: .8rem; background: var(--shell-surface); color: var(--shell-ink); font-weight: 730; }
.product-action-form button:hover { border-color: var(--shell-blue); color: var(--shell-blue); }
.product-action-form--stop button { border-color: color-mix(in srgb, var(--shell-red) 32%, var(--shell-rule)); color: var(--shell-red); }
.product-answer { display: grid; gap: .85rem; }
.product-answer h2 { margin: 0; font-size: 1.18rem; }
.product-answer-layer { padding: .8rem .9rem; border-radius: .85rem; background: var(--shell-blue-soft); }
.product-answer-layer h3 { margin: 0 0 .35rem; font-size: .82rem; }
.product-answer-layer ul { margin: 0; padding-inline-start: 1.1rem; }
.product-answer-layer--verified { background: var(--shell-green-soft); }
.product-answer-layer--unknown { background: var(--shell-amber-soft); }
.product-answer-layer--suggestion { background: var(--shell-blue-soft); }
.product-answer-layer li { margin-block: .25rem; }
.product-correction { padding: .8rem .9rem; border-inline-start: .25rem solid var(--shell-green); background: var(--shell-green-soft); }
.product-correction strong { color: var(--shell-green); }
.product-correction-form { display: grid; gap: .7rem; padding: .9rem; border: 1px solid var(--shell-rule); border-radius: .9rem; background: var(--shell-surface); }
.product-correction-form fieldset { display: flex; flex-wrap: wrap; gap: .65rem 1rem; margin: 0; padding: 0; border: 0; }
.product-correction-form legend { width: 100%; margin-block-end: .1rem; font-weight: 760; }
.product-correction-form label { display: inline-flex; align-items: center; gap: .35rem; color: var(--shell-muted); font-size: .88rem; }
.product-correction-form textarea { width: 100%; resize: vertical; min-height: 4.2rem; padding: .65rem .75rem; border: 1px solid var(--shell-rule); border-radius: .7rem; background: var(--shell-background); color: var(--shell-ink); font: inherit; }
.product-correction-form button { justify-self: start; }
.product-conversation-side { display: grid; align-content: start; gap: 1rem; }
.product-side-list { display: grid; gap: .6rem; margin: 0; padding: 0; list-style: none; }
.product-side-list li { display: flex; justify-content: space-between; gap: .65rem; padding-block: .55rem; border-block-end: 1px dashed var(--shell-rule); font-size: .86rem; }
.product-side-list li:last-child { border-block-end: 0; }
.product-side-list span { color: var(--shell-muted); }
.product-conversation-composer { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: .55rem; margin-block-start: 1rem; padding-block-start: .9rem; border-block-start: 1px solid var(--shell-rule); }
.product-conversation-composer input { min-width: 0; min-height: 2.75rem; padding: .6rem .75rem; border: 1px solid var(--shell-rule); border-radius: .8rem; background: var(--shell-surface); color: var(--shell-ink); }
.product-conversation-composer button { min-height: 2.75rem; padding-inline: 1rem; border: 0; border-radius: .8rem; background: var(--shell-blue); color: white; font-weight: 740; }
.product-turn-error { padding: .8rem .9rem; border-inline-start: .25rem solid var(--shell-amber); background: var(--shell-amber-soft); }
.product-turn-error p { margin: 0; }
.product-undo { display: flex; align-items: center; justify-content: space-between; gap: .8rem; margin-block-start: 1rem; padding: .75rem .9rem; border: 1px solid color-mix(in srgb, var(--shell-green) 27%, var(--shell-rule)); border-radius: var(--shell-radius-md); background: var(--shell-green-soft); }
.product-undo p { margin: 0; }
.product-undo button { min-height: 2.45rem; padding: .45rem .72rem; border: 1px solid var(--shell-green); border-radius: .7rem; background: var(--shell-surface); color: var(--shell-green); font-weight: 740; white-space: nowrap; }
.product-undo-note { color: var(--shell-muted); font-size: .8rem; }

.product-activity { display: grid; grid-template-columns: minmax(0, 1fr) minmax(17rem, 22rem); gap: 1.3rem; align-items: start; }
.product-activity-main { min-width: 0; }
.product-filters { display: flex; flex-wrap: wrap; gap: .55rem; margin-block-end: 1.1rem; }
.product-filters select, .product-filters button { min-height: 2.6rem; padding: .5rem .75rem; border: 1px solid var(--shell-rule); border-radius: .8rem; background: var(--shell-surface); color: var(--shell-ink); }
.product-filters button { color: var(--shell-blue); font-weight: 700; }
.product-activity-date { margin: 1.1rem 0 .55rem; color: var(--shell-muted); font-size: .9rem; font-weight: 760; letter-spacing: .04em; }
.product-activity-list { display: grid; gap: .65rem; margin: 0; padding: 0; list-style: none; }
.product-activity-item { display: grid; grid-template-columns: 4rem minmax(0, 1fr) auto; gap: .7rem; align-items: center; padding: .85rem 1rem; border: 1px solid var(--shell-rule); border-radius: var(--shell-radius-md); background: var(--shell-surface); }
.product-activity-time { color: var(--shell-subtle); font-variant-numeric: tabular-nums; }
.product-activity-copy { min-width: 0; }
.product-activity-copy strong { display: block; font-weight: 700; }
.product-attribution { display: inline-flex; align-items: center; min-height: 1.75rem; padding: .3rem .55rem; border-radius: .55rem; background: var(--shell-blue-soft); color: var(--shell-blue); font-size: .76rem; font-weight: 700; white-space: nowrap; }
.product-attribution[data-attribution="external-rule"] { background: var(--shell-purple-soft); color: var(--shell-purple); }
.product-attribution[data-attribution="physical"] { background: #f1eee7; color: #776f62; }
.product-attribution[data-attribution="system"] { background: #f1eee7; color: var(--shell-muted); }
.product-attribution[data-attribution="unknown"] { background: var(--shell-amber-soft); color: var(--shell-amber); }
.product-cause-aside { display: grid; gap: .85rem; }
.product-cause-highlight { padding: .85rem .9rem; border-inline-start: .25rem solid var(--shell-blue); border-radius: 0 .8rem .8rem 0; background: var(--shell-blue-soft); }
.product-cause-highlight strong { display: block; margin-block-end: .35rem; }
.product-cause-highlight p { margin: 0; }
.product-cause-chain { display: grid; gap: .35rem; }
.product-cause-chain li { padding-inline-start: .15rem; }
.product-cause-trigger { color: var(--shell-blue); font-weight: 700; }

.product-control-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1rem; }
.product-control-card { display: grid; gap: .8rem; }
.product-control-card header { display: flex; align-items: baseline; justify-content: space-between; gap: .6rem; }
.product-control-card header h2 { margin: 0; }
.product-control-state { color: var(--shell-muted); font-size: .85rem; }
.product-control-actions { display: flex; flex-wrap: wrap; gap: .5rem; }
.product-control-action { min-height: 2.5rem; padding: .48rem .7rem; border: 1px solid var(--shell-rule); border-radius: .75rem; background: var(--shell-surface); color: var(--shell-blue); font-weight: 700; }
.product-control-action:hover { border-color: var(--shell-blue); }
.product-result--unknown { border-style: dashed; border-color: var(--shell-amber); background: var(--shell-amber-soft); }
.product-result--failed { border-color: color-mix(in srgb, var(--shell-red) 38%, var(--shell-rule)); background: var(--shell-red-soft); }
.product-control-feedback { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin-block-end: 1.15rem; }
.product-control-feedback-copy { min-width: 0; }
.product-control-feedback-copy h2, .product-control-feedback-copy p { margin: 0; }
.product-control-feedback-copy h2 { margin-block-end: .3rem; }
.product-control-feedback-copy p:not(.product-kicker) { color: var(--shell-muted); }
.product-control-feedback-expiry { display: inline-flex; margin-block-start: .5rem; color: var(--shell-amber); font-size: .84rem; font-variant-numeric: tabular-nums; }
.product-control-feedback--verified { border-color: color-mix(in srgb, var(--shell-green) 28%, var(--shell-rule)); background: var(--shell-green-soft); }
.product-control-feedback--pending_confirmation { border-color: color-mix(in srgb, var(--shell-amber) 30%, var(--shell-rule)); background: var(--shell-amber-soft); }
.product-control-feedback--failed { border-color: color-mix(in srgb, var(--shell-red) 30%, var(--shell-rule)); background: var(--shell-red-soft); }
.product-control-feedback--unknown { border-style: dashed; border-color: var(--shell-amber); background: var(--shell-amber-soft); }
.product-batch-control { display: grid; gap: 1rem; margin-block-end: 1.15rem; }
.product-batch-header h2, .product-batch-header p { margin: 0; }
.product-batch-header h2 { margin-block-end: .3rem; }
.product-batch-form { display: grid; gap: .9rem; }
.product-batch-form fieldset { margin: 0; padding: 0; border: 0; }
.product-batch-items { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: .55rem; }
.product-batch-item { display: flex; align-items: flex-start; gap: .6rem; min-height: 3.1rem; padding: .7rem; border: 1px solid var(--shell-rule); border-radius: .75rem; background: var(--shell-surface); cursor: pointer; }
.product-batch-item:has(input:checked) { border-color: var(--shell-blue); background: var(--shell-blue-soft); }
.product-batch-item input { margin-block-start: .2rem; accent-color: var(--shell-blue); }
.product-batch-item-copy { display: grid; gap: .18rem; min-width: 0; }
.product-batch-item-copy small { color: var(--shell-muted); }
.product-batch-summary { display: flex; flex-wrap: wrap; gap: .65rem; }
.product-batch-count { display: inline-flex; align-items: baseline; gap: .3rem; padding: .5rem .65rem; border-radius: .7rem; background: var(--shell-subtle); }
.product-batch-count strong { font-size: 1.1rem; font-variant-numeric: tabular-nums; }
.product-batch-count small { color: var(--shell-muted); }
.product-batch-results { display: grid; gap: .6rem; }
.product-batch-results h3 { margin: 0; }
.product-batch-results ul { display: grid; gap: .55rem; margin: 0; padding: 0; list-style: none; }
.product-batch-result { padding: .7rem; border: 1px solid var(--shell-rule); border-radius: .7rem; }
.product-batch-result > div { display: flex; justify-content: space-between; gap: .7rem; }
.product-batch-result p { margin: .35rem 0 0; color: var(--shell-muted); }
.product-batch-result small { color: var(--shell-muted); }
.product-batch-result--verified { border-color: color-mix(in srgb, var(--shell-green) 28%, var(--shell-rule)); background: var(--shell-green-soft); }
.product-batch-result--pending_confirmation { border-color: color-mix(in srgb, var(--shell-amber) 30%, var(--shell-rule)); background: var(--shell-amber-soft); }
.product-batch-result--failed { border-color: color-mix(in srgb, var(--shell-red) 30%, var(--shell-rule)); background: var(--shell-red-soft); }
.product-batch-result--unknown { border-style: dashed; border-color: var(--shell-amber); background: var(--shell-amber-soft); }

.product-settings-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; max-width: 58rem; }
.product-settings-list { display: grid; gap: .5rem; margin: 0; padding: 0; list-style: none; }
.product-settings-list li { display: flex; justify-content: space-between; gap: .8rem; padding-block: .65rem; border-block-end: 1px dashed var(--shell-rule); }
.product-settings-list li:last-child { border-block-end: 0; }
.product-settings-list span { color: var(--shell-muted); }
.product-onboarding { max-width: 66rem; }
.product-onboarding-progress { display: grid; grid-template-columns: repeat(8, minmax(0, 1fr)); gap: .35rem; margin-block: 1rem 1.4rem; }
.product-onboarding-step { min-height: .38rem; border-radius: 999px; background: var(--shell-rule); }
.product-onboarding-step[data-state="complete"], .product-onboarding-step[data-state="current"] { background: var(--shell-blue); }
.product-onboarding-content { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(16rem, .9fr); gap: 1.2rem; }
.product-onboarding-list { display: grid; gap: .35rem; margin: 0; padding: 0; list-style: none; }
.product-onboarding-list li { display: flex; align-items: baseline; gap: .6rem; padding: .62rem .7rem; border-radius: .75rem; color: var(--shell-muted); }
.product-onboarding-list li[data-state="current"] { background: var(--shell-blue-soft); color: var(--shell-blue); font-weight: 760; }
.product-onboarding-list li[data-state="complete"] { color: var(--shell-green); }
.product-onboarding-index { width: 1.35rem; font-variant-numeric: tabular-nums; }
.product-onboarding-form-panel { display: grid; gap: 1rem; align-content: start; }
.product-onboarding-form-panel h2 { margin-block-end: 0; }
.product-onboarding-form { display: grid; gap: .9rem; }
.product-onboarding-field { display: grid; gap: .42rem; min-width: 0; }
.product-onboarding-field-label, .product-onboarding-fieldset legend { color: var(--shell-ink); font-size: .9rem; font-weight: 740; }
.product-onboarding-field input:not([type="radio"]):not([type="checkbox"]), .product-onboarding-field select, .product-onboarding-field textarea { width: 100%; min-height: 2.75rem; padding: .65rem .75rem; border: 1px solid var(--shell-rule); border-radius: .75rem; background: var(--shell-surface); color: var(--shell-ink); }
.product-onboarding-field textarea { min-height: 5.5rem; resize: vertical; }
.product-onboarding-field input::placeholder, .product-onboarding-field textarea::placeholder { color: var(--shell-subtle); }
.product-onboarding-fieldset { min-inline-size: 0; margin: 0; padding: 0; border: 0; }
.product-onboarding-fieldset legend { padding: 0; }
.product-onboarding-choices { display: grid; gap: .45rem; }
.product-onboarding-choice { display: grid; grid-template-columns: 1.25rem minmax(0, 1fr); gap: .55rem; align-items: start; min-height: 2.75rem; padding: .55rem .65rem; border: 1px solid var(--shell-rule); border-radius: .75rem; background: var(--shell-surface); cursor: pointer; }
.product-onboarding-choice input { width: 1.15rem; height: 1.15rem; margin: .2rem 0 0; accent-color: var(--shell-blue); }
.product-onboarding-choice span { display: grid; gap: .16rem; }
.product-onboarding-choice strong { font-size: .9rem; font-weight: 680; }
.product-onboarding-choice small, .product-onboarding-help { color: var(--shell-muted); font-size: .8rem; line-height: 1.4; }
.product-onboarding-items { display: grid; gap: .5rem; margin: 0; padding: 0; list-style: none; }
.product-onboarding-item { display: grid; grid-template-columns: 1.55rem minmax(0, 1fr) auto; gap: .55rem; align-items: start; padding: .7rem .75rem; border-block-end: 1px solid var(--shell-rule); }
.product-onboarding-item:last-child { border-block-end: 0; }
.product-onboarding-item-index { width: 1.45rem; height: 1.45rem; display: grid; place-items: center; border-radius: 50%; background: var(--shell-blue-soft); color: var(--shell-blue); font-size: .78rem; font-variant-numeric: tabular-nums; }
.product-onboarding-item-copy { display: grid; gap: .12rem; min-width: 0; }
.product-onboarding-item-copy strong { font-weight: 740; }
.product-onboarding-item-copy span { color: var(--shell-muted); font-size: .86rem; }
.product-onboarding-item-status { color: var(--shell-muted); font-size: .8rem; white-space: nowrap; }
.product-onboarding-item[data-tone="verified"] .product-onboarding-item-index { background: var(--shell-green-soft); color: var(--shell-green); }
.product-onboarding-item[data-tone="warning"] .product-onboarding-item-index { background: var(--shell-amber-soft); color: var(--shell-amber); }
.product-onboarding-item[data-tone="danger"] .product-onboarding-item-index { background: var(--shell-red-soft); color: var(--shell-red); }
.product-onboarding-submit { width: 100%; min-height: 2.9rem; border-radius: .85rem; }
.product-onboarding-note { margin: 0; color: var(--shell-muted); font-size: .86rem; text-align: center; }

.product-voice { display: grid; gap: 1rem; max-width: 58rem; margin-inline: auto; }
.product-voice-stage { min-height: 22rem; display: grid; place-items: center; align-content: center; gap: 1rem; text-align: center; }
.product-voice-stage .product-card-actions { display: flex; flex-wrap: wrap; justify-content: center; gap: .55rem; }
.product-voice-indicator { width: 6rem; height: 6rem; border: .35rem solid color-mix(in srgb, var(--shell-blue) 22%, transparent); border-radius: 50%; background: transparent; box-shadow: inset 0 0 0 .35rem var(--shell-blue); opacity: .82; animation: product-voice-breathe 3.6s cubic-bezier(.25, 1, .5, 1) infinite; }
.product-voice-status { margin: 0; color: var(--shell-blue); font-size: 1.05rem; font-weight: 760; }
.product-voice-detail { max-width: 48ch; }
.product-voice-transcript { width: min(100%, 42rem); min-height: 3.8rem; display: grid; place-items: center; margin: .2rem 0 0; padding: .85rem 1rem; border: 1px dashed var(--shell-rule); border-radius: var(--shell-radius-md); color: var(--shell-ink); font-size: clamp(1.05rem, 2.2vw, 1.35rem); line-height: 1.4; }
.product-voice-transcript[data-voice-transcript-kind="empty"] { color: var(--shell-subtle); font-size: .95rem; }
.product-voice-transcript[data-voice-transcript-kind="partial"] { border-color: color-mix(in srgb, var(--shell-blue) 38%, var(--shell-rule)); background: var(--shell-blue-soft); color: var(--shell-blue); }
.product-voice-transcript[data-voice-transcript-kind="final"] { border-style: solid; background: var(--shell-surface); font-weight: 680; }
.product-voice-fallback { width: min(100%, 42rem); margin: 0; padding: .75rem 1rem; border-inline-start: .25rem solid var(--shell-amber); background: var(--shell-amber-soft); color: var(--shell-amber); text-align: start; }
.product-voice-submit-form { display: none; }
.product-voice-intent blockquote { margin: .65rem 0 1.15rem; font-size: clamp(1.25rem, 3vw, 2rem); font-weight: 680; line-height: 1.35; letter-spacing: -.02em; }
.product-voice[data-voice-state="permission_denied"] .product-voice-indicator,
.product-voice[data-voice-state="failed"] .product-voice-indicator,
.product-voice[data-voice-state="indeterminate"] .product-voice-indicator { border-color: color-mix(in srgb, var(--shell-red) 22%, transparent); box-shadow: inset 0 0 0 .35rem var(--shell-red); animation-play-state: paused; }
.product-voice[data-voice-state="awaiting_confirmation"] .product-voice-indicator,
.product-voice[data-voice-state="presenting_choice"] .product-voice-indicator { border-color: color-mix(in srgb, var(--shell-amber) 22%, transparent); box-shadow: inset 0 0 0 .35rem var(--shell-amber); animation-play-state: paused; }
.product-voice[data-voice-state="listening"] .product-voice-indicator,
.product-voice[data-voice-state="partial_transcript"] .product-voice-indicator { border-color: color-mix(in srgb, var(--shell-blue) 26%, transparent); box-shadow: inset 0 0 0 .35rem var(--shell-blue); }
.product-voice[data-voice-state="speaking"] .product-voice-indicator { border-color: color-mix(in srgb, var(--shell-green) 22%, transparent); box-shadow: inset 0 0 0 .35rem var(--shell-green); }
.product-voice[data-voice-state="cancelled"] .product-voice-indicator,
.product-voice[data-voice-state="text_mode"] .product-voice-indicator { border-color: var(--shell-rule); box-shadow: inset 0 0 0 .35rem var(--shell-subtle); animation-play-state: paused; }
@keyframes product-voice-breathe { 0%, 100% { transform: scale(.88); opacity: .58; } 50% { transform: scale(1); opacity: .94; } }

.product-mobile-nav { display: none; }

@media (max-width: 72rem) {
  .product-overview-grid { grid-template-columns: minmax(0, 1fr); }
  .product-overview-aside { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .product-control-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .product-batch-items { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

@media (max-width: 56rem) {
  .product-layout { display: block; }
  .product-sidebar { display: none; }
  .product-main { padding: 1.3rem 1rem calc(11rem + env(safe-area-inset-bottom)); }
  .product-page-header { align-items: start; }
  .product-page-header h1 { font-size: 1.85rem; }
  .product-safety-banner { align-items: start; flex-direction: column; gap: .65rem; padding-block: .8rem; }
  .product-safety-meta { justify-content: start; }
  .product-overview-grid, .product-space-grid, .product-review-page, .product-conversation, .product-activity, .product-settings-grid, .product-onboarding-content { grid-template-columns: minmax(0, 1fr); }
  .product-overview-aside { grid-template-columns: minmax(0, 1fr); }
  .product-control-grid { grid-template-columns: minmax(0, 1fr); }
  .product-batch-items { grid-template-columns: minmax(0, 1fr); }
  .product-conversation-main { min-height: auto; }
  .product-conversation-side { order: 2; }
  .product-voice-stage { min-height: 20rem; padding: 1rem; }
  .product-voice-stage .product-card-actions { width: 100%; }
  .product-voice-stage .product-card-actions > * { flex: 1 1 9rem; }
  .product-stepper { grid-template-columns: minmax(0, 1fr); }
  .product-step { border-inline-end: 0; border-block-end: 1px solid var(--shell-rule); }
  .product-step:last-child { border-block-end: 0; }
  .product-detail-columns { grid-template-columns: minmax(0, 1fr); }
  .product-activity-item { grid-template-columns: 3.5rem minmax(0, 1fr); }
  .product-activity-item .product-attribution { grid-column: 2; justify-self: start; }
  .product-onboarding-item { grid-template-columns: 1.55rem minmax(0, 1fr); }
  .product-onboarding-item-status { grid-column: 2; justify-self: start; }
  .product-main > .product-composer { position: fixed; z-index: 14; inset-inline: .75rem; inset-block-end: calc(4.75rem + env(safe-area-inset-bottom)); margin: 0; }
  .product-main > .product-helper-copy { display: none; }
  .product-shell[data-route="onboarding"] .product-main { width: min(100%, 42rem); padding-block-end: calc(2rem + env(safe-area-inset-bottom)); }
  .product-shell[data-route="onboarding"] .product-onboarding-content { display: block; }
  .product-shell[data-route="onboarding"] .product-onboarding-list { display: none; }
  .product-shell[data-route="onboarding"] .product-mobile-nav { display: none; }
  .product-mobile-nav { position: fixed; z-index: 15; inset-inline: 0; inset-block-end: 0; display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: .15rem; padding: .45rem .45rem calc(.45rem + env(safe-area-inset-bottom)); border-block-start: 1px solid var(--shell-rule); background: color-mix(in srgb, var(--shell-surface) 94%, transparent); backdrop-filter: blur(18px); box-shadow: 0 -8px 22px rgba(24, 36, 58, .06); }
  .product-mobile-nav-link { position: relative; display: grid; justify-items: center; gap: .18rem; min-height: 3.6rem; padding: .4rem .15rem; border-radius: .75rem; color: var(--shell-muted); text-decoration: none; font-size: .7rem; font-weight: 650; }
  .product-mobile-nav-link[aria-current="page"] { background: var(--shell-blue-soft); color: var(--shell-blue); font-weight: 760; }
  .product-mobile-nav-icon { height: 1.25rem; font-size: 1.15rem; line-height: 1.2; }
  .product-mobile-nav-badges { position: absolute; inset-block-start: .05rem; inset-inline-end: .55rem; display: inline-flex; gap: .15rem; }
  .product-mobile-nav-badges .product-badge { min-width: 1.25rem; height: 1.25rem; padding-inline: .2rem; font-size: .64rem; }
}

@media (max-width: 28rem) {
  .product-main { padding-inline: .75rem; }
  .product-card { padding: 1rem; border-radius: var(--shell-radius-md); }
  .product-status-card { align-items: start; flex-direction: column; gap: .45rem; }
  .product-composer { grid-template-columns: minmax(0, 1fr) auto; }
  .product-undo { align-items: start; flex-direction: column; }
  .product-undo button { width: 100%; }
  .product-activity-item { grid-template-columns: minmax(0, 1fr); }
  .product-activity-item .product-attribution { grid-column: auto; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; transition-duration: .01ms !important; animation-duration: .01ms !important; animation-iteration-count: 1 !important; }
}

@media (prefers-reduced-transparency: reduce) {
  .product-mobile-nav { background: var(--shell-surface); backdrop-filter: none; }
}

@media (prefers-contrast: more) {
  :root { --shell-rule: #8c96a5; --shell-muted: #465367; --shell-subtle: #465367; }
  .product-card, .product-status-card, .product-activity-item, .product-mobile-nav { border-width: 2px; }
  .product-safety-banner { border-block-end: 3px solid #fff; }
}
`;

export const PRODUCT_SHELL_STYLES = PRODUCT_SHELL_CSS;
