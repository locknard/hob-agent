# Structured proposal review feedback

Status: accepted for Phase 0 implementation.

The real-household acceptance target is not merely that the Home Agent can
create a proposal. The household must be able to state whether the suggestion
was useful and, when it was not, why. A free-form review note alone cannot be
counted reliably across observations and must not be interpreted later by the
model as an instruction or an automatic policy change.

The Hub therefore records one bounded decision-specific feedback code beside
the existing optional review note:

- approval: `useful_as_is`;
- rejection: `already_covered`, `not_useful`, `incorrect_assumption`,
  `insufficient_evidence`, `household_preference`, `too_risky`, or `other`.

`other` requires a non-empty bounded note. Expiration is a lifecycle event, not
quality feedback, and carries no feedback code. New manual approve/reject
reviews require a valid code; existing persisted v1 rows without a code remain
readable. The code is copied into the append-only proposal audit event so a
future local quality report does not need to reinterpret prose.

The Inbox presents these choices in plain household language and displays the
recorded result after review. Feedback is local household data. It does not
modify `HOME.md`, `MEMORY.md`, prompts, Skills, tool authority, proposal policy,
or device state automatically. A later explicit, human-reviewed knowledge
workflow may use aggregated feedback as evidence for a proposed correction.

