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

When confidence is `partial` or `insufficient`, every hardware suggestion is
optional and requires a reversible validation trial before purchase. A
`recommended` suggestion is accepted only with `sufficient` evidence. Report
prose is household-facing and rejects opaque Hub IDs and known internal
diagnostic codes. Safety-device trials use manufacturer-approved procedures
and must not create a hazard.

## Request and execution boundaries

- Questions are UTF-8 text from 1 to 1,000 characters and are always untrusted
  input. They cannot add tools, authority, instructions, or policy exceptions.
- Only one advice turn may run at a time. It shares the governed Agent tool
  budget with autonomous observation, but uses an independent five-minute
  product deadline because the persisted request continues after the HTTP
  response and may need several bounded evidence reads.
- Every DSH model step has a 4,096-token output ceiling, including custom
  OpenAI-compatible deployments whose provider default is otherwise unknown.
- Detailed snapshot pages have a 7,500-byte model-visible ceiling. Pages shrink
  deterministically; an individually oversized device fails closed and must be
  queried again with narrower semantic kinds instead of flooding the next
  model step.
- Starting a question persists a `running` record and returns immediately. The
  Hub owns the background DSH turn, cancellation, terminal persistence, and a
  bounded in-memory semantic progress log.
- A request fails closed when HomeWorld is not ready, the Agent is busy, or the
  model does not publish exactly one valid structured report.
- The Inbox accepts requests only through authenticated, exact-same-origin
  form posts with bounded bodies. Standalone Inbox mode may read prior reports
  but cannot start a new Agent turn.
- Running report pages consume an authenticated same-origin SSE endpoint with
  monotonic event IDs, cursor replay, heartbeat, and terminal close. The stream
  exposes only household-facing lifecycle stages and bounded answer text; raw
  DSH events, prompts, hidden reasoning, tool arguments, tool results, and
  provider errors never cross the HTTP boundary.
- Reports are visibly labelled Agent-authored. Hub evidence returned by tools
  remains the authority for observed state; report prose is never promoted to
  Hub evidence.

## First product workflow

The Inbox presents an “Ask about your home” form and a bounded recent-report
list. A report page separates: answer, what the Agent found, what remains
unknown, a proposed trial, sensing gaps, and how to validate. This is a
request/response document workflow, not a native chat application.

While a report is running, the page uses household language for accepted,
inventory, routine, evidence, snapshot, and answer-writing activity; only
stages actually observed from the redacted DSH trace are marked complete. A
reload or brief connection loss resumes the same request rather than starting
another one, and the household can stop waiting without applying any change.

The reusable acceptance matrix is documented in
[`household-advice-evaluation.md`](household-advice-evaluation.md). Real-home
fixtures and answers remain private and are never committed.
