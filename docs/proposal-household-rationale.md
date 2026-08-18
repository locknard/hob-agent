# Household proposal rationale

Status: accepted for Phase 0 implementation.

A trustworthy household proposal must make its product case separately from
its evidence and safety record. A title and summary are not enough to explain
why the Home Agent chose to interrupt the household, especially in a real home
with many capabilities, incomplete room assignment, and existing automations.

Every new Agent-created proposal therefore carries a bounded rationale with:

- the expected household value;
- why the suggestion is timely now; and
- one to six concrete uncertainties that still require human judgment or more
  observation.

These statements are model-authored and untrusted. The Inbox labels them as the
Agent's case; they cannot replace Hub-produced evidence coverage, current bridge
watermarks, rule-overlap findings, risk reasons, approval, or policy. A proposal
must not claim certainty merely because its rationale sounds confident.

The Hub validates size and presence before accepting a new Agent draft. The DSH
household-observation workflow directs the Agent to create no proposal when it
cannot state a material value, a specific reason for the timing, a limitation,
and a clear rollback. Existing persisted v1 proposals without a rationale
remain readable and are labeled as legacy records in the Inbox.

The rationale grants no action, artifact, memory, filesystem, Skill, or device
authority. It remains local proposal content and follows the same persistence
and review rules as the rest of the envelope.

