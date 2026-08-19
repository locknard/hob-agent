---
name: hob-agent
description: A calm household evidence desk for reviewing Agent proposals.
colors:
  canvas: "oklch(97.5% 0.008 145)"
  surface: "oklch(99.2% 0.004 145)"
  surface-muted: "oklch(95% 0.012 145)"
  ink: "oklch(25% 0.025 242)"
  ink-muted: "oklch(48% 0.022 242)"
  rule: "oklch(87% 0.014 145)"
  primary: "oklch(55% 0.17 252)"
  verified: "oklch(48% 0.09 145)"
  verified-soft: "oklch(93% 0.045 145)"
  uncertain: "oklch(60% 0.12 55)"
  uncertain-soft: "oklch(94% 0.045 55)"
  danger: "oklch(50% 0.14 25)"
typography:
  headline:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif"
    fontSize: "2rem"
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: "-0.035em"
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 700
    lineHeight: 1.25
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 750
    lineHeight: 1.5
    letterSpacing: "0.1em"
rounded:
  sm: "0.4rem"
  md: "0.75rem"
  pill: "999px"
spacing:
  xs: "0.25rem"
  sm: "0.5rem"
  md: "0.75rem"
  lg: "1.5rem"
  xl: "2rem"
  2xl: "3rem"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.surface}"
    rounded: "{rounded.sm}"
    padding: "0.5rem 1.5rem"
    height: "2.75rem"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.danger}"
    rounded: "{rounded.sm}"
    padding: "0.5rem 1.5rem"
    height: "2.75rem"
  status-chip:
    backgroundColor: "{colors.verified-soft}"
    textColor: "{colors.verified}"
    rounded: "{rounded.pill}"
    padding: "0.25rem 0.75rem"
---

# Design System: hob-agent

## Overview

**Creative North Star: "The Household Evidence Desk"**

The interface should feel like a quiet place to examine one consequential idea,
not a cockpit for operating every device. Familiar Home Assistant navigation
provides orientation, while a continuous review sheet separates Agent-authored
claims from Hub evidence and household judgment.

The visual system is light because the primary scene is a household member
checking a phone or tablet in ordinary daytime home light. Density is practical,
not sparse, and the evidence ledger is the one distinctive motif. Runtime detail
stays available through native disclosure instead of competing with the decision.

**Key Characteristics:**

- Familiar navigation, decision-first hierarchy.
- Continuous surfaces divided by rules, not nested cards.
- Restrained color with explicit words for every status.
- Mobile-first flow from suggestion to evidence to decision.
- Script-free interactions where native HTML is sufficient.

## Colors

The palette combines sage-tinted household surfaces with inky blue text. Blue is
reserved for a primary decision; evergreen marks verified Hub information and
clay orange marks uncertainty.

**The Rare Blue Rule.** Primary blue occupies less than ten percent of a screen
and appears only for the current location, keyboard focus, links, and the main
approval action.

**The Written Status Rule.** Verified, uncertain, failed, approved, and rejected
always appear as words. Color is reinforcement, never the only signal.

## Typography

The native system sans stack makes the local product feel immediate on macOS,
Windows, Linux, iOS, and Android without font downloads or layout shift. A tight
five-step hierarchy uses size, weight, space, and color together. Body prose is
limited to 68 characters where practical, while timestamps and counts use
tabular numerals.

**The Household Language Rule.** Labels name what a household member recognizes.
Runtime vocabulary belongs inside Agent details, never in the primary heading or
decision controls.

## Elevation

The system is flat by default. Canvas, surface, one-pixel rules, and spacing
create structure. Shadows are forbidden on ordinary sections and list rows;
only the evidence marker uses a one-pixel outline so it remains legible over its
timeline.

**The Continuous Sheet Rule.** A review is one document. Do not break its
rationale, evidence, risk, and decision into floating cards.

## Components

### Navigation

Navigation uses a full vertical rail at 64rem and above, and a horizontally
scrollable 44px-high strip below it. The active location uses the verified-soft
surface plus text, not color alone. Every destination resolves to a real section.

### Proposal rows

Rows use whitespace and a bottom rule. Titles are links; status metadata aligns
to the right when space permits and returns below the title on narrow screens.

### Evidence ledger

Evidence is chronological and source-led. Each item has a small marker, a plain
identifier, observation time, source, and sequence when recorded. Partial or
unavailable coverage uses the uncertainty color and retains its status word.

### Buttons and fields

Buttons and fields have a 44px minimum height and gently curved edges. Primary
approval is blue; rejection is a bordered surface with danger-colored text.
Keyboard focus uses a three-pixel translucent blue ring with three-pixel offset.
Textareas remain vertically resizable and every field has a visible label.

### Agent details

Native details and summary elements hold the DSH trace and accumulated
calibration metrics. They are closed by default and remain accessible without
client-side JavaScript.

## Do's and Don'ts

### Do:

- **Do** lead with the proposal, household value, uncertainty, and evidence.
- **Do** retain the evidence ledger as the signature review pattern.
- **Do** keep approvals explicit and repeat that approval records intent only.
- **Do** use the 4px spacing scale and 44px minimum interaction targets.
- **Do** adapt to a single-column mobile reading order instead of shrinking the
  desktop columns.

### Don't:

- **Don't** make a miniature Home Assistant device-control dashboard or a wall
  of toggles.
- **Don't** wrap home controls in a chatbot.
- **Don't** turn Agent metadata into a dark engineering console or raw trace
  viewer.
- **Don't** use gradients, glowing effects, glassmorphism, giant metrics, or
  decorative automation to make the Agent look theatrical.
- **Don't** use nested cards or a colored border stripe on list items.
- **Don't** display secrets in forms after saving, ordinary configuration,
  proposal evidence, Agent context, logs, traces, or backups.
