# Aggregate household calibration summary

Status: accepted for Phase 0 implementation.

The product goal is useful household proposals, not merely successful model
turns. Structured proposal feedback and Agent-reported no-proposal dispositions
are already durable, but inspecting individual records cannot show whether the
loop is improving.

The Hub therefore exposes all-time, aggregate-only local summaries:

- proposal counts by lifecycle status;
- reviewed proposal counts by bounded feedback code;
- the count of legacy reviewed proposals without structured feedback;
- observation lifecycle totals and completed counts by closed Hub outcome;
- no-proposal counts by bounded Agent-reported disposition; and
- the count of no-proposal attempts without a reported disposition; and
- measured observation count plus cumulative duration, model-token counters,
  tool calls, and failed tool calls.

The SQLite stores compute these summaries directly from bounded columns and
review codes. The Inbox receives counts only. It does not load or reinterpret
proposal titles, rationale, notes, device/space identities, observation IDs,
model text, or tool traces for calibration.
Metric totals include only attempts written after numeric run metrics became
available; the measured-attempt count makes legacy coverage explicit. They are
observed usage facts, not monetary estimates.

These metrics are descriptive, not authority. They do not modify household
files, prompts, Skills, schedules, policy, model selection, proposals, or
devices. Any future change based on them remains an explicit reviewed product
decision.

## Agent-facing bounded calibration

The autonomous Home Skill also reads `get_home_calibration` before inspecting
the current home. This read-only tool returns the same aggregate proposal
counts plus a fixed bounded window of at most 20 recent approved/rejected items containing only an opaque
proposal ID, kind, bounded title, decision time, and structured feedback code.
Reviewer identity and free-form notes are omitted. Expired and pending items do
not appear in the recent-review projection.

During an autonomous observation, proposal creation remains closed until this
tool has completed once. The fixed window has no model-selected limit or cursor
that can silently skip newer feedback. Outside an autonomous observation the
gate is inactive.

Historical proposal titles remain untrusted content. A rejection helps the
Agent avoid repeating a topic; an approval is preference evidence only. Neither
can waive current evidence, conflict inspection, policy, review, or execution
boundaries. The tool does not write `MEMORY.md` or silently tune the runtime.
