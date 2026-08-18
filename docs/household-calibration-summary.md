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
- the count of no-proposal attempts without a reported disposition.

The SQLite stores compute these summaries directly from bounded columns and
review codes. The Inbox receives counts only. It does not load or reinterpret
proposal titles, rationale, notes, device/space identities, observation IDs,
model text, or tool traces for calibration.

These metrics are descriptive, not authority. They do not modify household
files, prompts, Skills, schedules, policy, model selection, proposals, or
devices. Any future change based on them remains an explicit reviewed product
decision.
