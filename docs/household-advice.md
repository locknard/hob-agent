# Household advice requests

## Decision

Phase 0 supports one-shot household advice requests, not an open-ended chat
runtime. An authenticated local household member may submit one bounded
question. The existing DSH Home Agent may inspect only the governed Home
Product Bundle tools and must finish the turn by publishing one structured
advice report.

Advice is distinct from a proposal:

- it explains observations, uncertainty, a reversible trial, optional sensing
  gaps, and how the household can validate the result;
- it cannot control a device, install an automation, change configuration, or
  approve anything;
- accepting an answer does not grant authority. A later persistent change must
  still enter the existing proposal, evidence/dry-run, approval, artifact, and
  audit path;
- the question and report are private household data persisted locally under
  `HOB_DATA_DIR` and never enter logs or metadata-only Agent traces.

## Bounded report

Every completed report contains:

- a short answer summary;
- an evidence confidence of `sufficient`, `partial`, or `insufficient`;
- bounded Agent-authored findings and unknowns;
- at most one reversible trial, including duration, success criteria, and
  rollback;
- zero to four hardware capability suggestions; and
- bounded validation steps.

Hardware suggestions describe a sensing capability, not a product or vendor.
The closed Phase 0 capability vocabulary is: illuminance, motion, presence,
contact, temperature, humidity, air quality, energy, leak, and weather. Each
suggestion must explain why the signal matters, an installation location when
relevant, privacy impact, and a no-purchase alternative. The Agent must inspect
the full neutral inventory before claiming that a capability is missing.
Camera and microphone purchases are outside this first slice.

## Request and execution boundaries

- Questions are UTF-8 text from 1 to 1,000 characters and are always untrusted
  input. They cannot add tools, authority, instructions, or policy exceptions.
- Only one advice turn may run at a time, and it shares the Agent's bounded
  deadline and tool budget with autonomous observation.
- A request fails closed when HomeWorld is not ready, the Agent is busy, or the
  model does not publish exactly one valid structured report.
- The Inbox accepts requests only through authenticated, exact-same-origin
  form posts with bounded bodies. Standalone Inbox mode may read prior reports
  but cannot start a new Agent turn.
- Reports are visibly labelled Agent-authored. Hub evidence returned by tools
  remains the authority for observed state; report prose is never promoted to
  Hub evidence.

## First product workflow

The Inbox presents an “Ask about your home” form and a bounded recent-report
list. A report page separates: answer, what the Agent found, what remains
unknown, a proposed trial, sensing gaps, and how to validate. This is a
request/response document workflow, not a native chat application.
