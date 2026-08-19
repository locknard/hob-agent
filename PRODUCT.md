# hob-agent Product

## Register

product

## Users

The primary users are household members reviewing the Agent's understanding and
recommendations on a phone, tablet, or shared computer. They should not need to
understand Home Assistant, bridge contracts, model providers, or Agent runtime
internals. Developers and advanced operators are secondary users; diagnostic
details remain available through progressive disclosure instead of dominating
the household workflow.

## Product Purpose

hob-agent is an agent-first smart-home hub that turns bounded household evidence
into trustworthy, reviewable automation proposals. Its interface helps people
understand what the Agent noticed, why it matters now, what evidence supports the
idea, what remains uncertain, and whether the household should approve or reject
the proposal. Approval records intent only during Phase 0; it does not silently
install automation or control devices.

The interface also provides product-grade setup for home bridges, model
providers, and local access. Secrets are entered and managed through secure
credential flows, stored separately from ordinary configuration, never echoed
after saving, and never exposed to Agent context, traces, logs, or backups.

## Brand Personality

Calm, trustworthy, and domestic. The voice is plain, specific, and respectful of
household judgment. The product should feel attentive without pretending to be
human, confident about recorded facts, and candid about uncertainty.

## Anti-references

- Not a miniature Home Assistant device-control dashboard or a wall of toggles.
- Not a chatbot wrapped around home controls.
- Not a dark engineering console, observability product, or raw Agent trace viewer.
- Not a theatrical AI dashboard filled with gradients, glowing effects, or
  decorative automation.
- Not a dense settings surface that asks household members to understand provider
  internals or paste secrets into ordinary configuration files.

## Design Principles

1. Lead with the household decision. Pending reviews and their consequence come
   before runtime metrics or system internals.
2. Separate claims from evidence. Model-authored reasoning, Hub-produced facts,
   uncertainty, and household decisions must remain visually distinguishable.
3. Reveal complexity on demand. Everyday language is the default; diagnostic
   traces and detailed measurements are available without becoming the homepage.
4. Make safety visible. Read-only state, bounded evidence, approval boundaries,
   secret handling, and failure states should be understandable rather than
   hidden behind reassurance.
5. Borrow proven navigation patterns, not another product's identity. Home
   Assistant informs responsive navigation and status language, while hob-agent
   remains centered on observation and review instead of device control.

## Accessibility & Inclusion

Target WCAG 2.2 AA. All essential workflows must support keyboard and touch,
visible focus, semantic landmarks, descriptive labels, sufficient contrast, and
44px minimum touch targets. Meaning cannot depend on color alone. Respect reduced
motion and avoid timed interactions. Design mobile-first for household members
who may be standing, distracted, or using the interface in varied home lighting.
