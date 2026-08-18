# Governed home observation scheduling

Status: accepted for Phase 0 implementation.

## Product reason

The Home Agent now has a bounded view of the home and can create a proposal
with Hub-bound evidence, but a running process still never asks it to observe.
The first autonomous step should be deliberately small: a local, opt-in
periodic trigger that starts one DSH turn only when the world is consistent and
the household has no pending proposal to review.

## Decision

- `packages/hub` owns the clock and trigger policy.
- The existing DSH Home Agent owns the resulting turn. No second loop, worker,
  or proposal engine is introduced.
- The full runtime always mounts the same Hub observation controller. Its
  authenticated Inbox may explicitly request one governed turn even when no
  recurring interval is configured.
- Scheduling is disabled unless an explicit interval is configured. The
  interval is bounded from 60 minutes to seven days; an optional explicit flag
  may request one observation after startup readiness.
- A startup observation waits for every configured bridge represented in the
  HomeWorld snapshot to report `ready` and a verified watermark.
- At most one observation turn runs at a time. A busy Agent is skipped rather
  than interrupted.
- Any pending Inbox proposal suppresses later observations. The household must
  review the existing item before the Agent may generate another one.
- The Hub proposal boundary also rejects a second distinct draft while one is
  pending; this limit is enforced in code rather than left to prompt wording.
- The trusted product prompt asks for at most one materially useful proposal
  and permits no proposal when evidence is insufficient. It does not include
  household data; the Agent must use governed tools.
- Household-wide discovery must exhaust the compact `get_home_inventory`
  cursor before selecting a small candidate set for detailed snapshot reads.
  It then uses bounded `get_home_activity` metadata for candidate triage
  without treating activity as proof of a household routine.
  The autonomous runtime gate rejects proposal creation after a partial,
  out-of-order, or version-changing inventory; this is not left to prompt
  compliance.
- Existing-rule inspection must likewise exhaust a stable `get_home_rules`
  cursor sequence before proposal creation. A skipped, reordered, or
  version-changing catalog fails closed while the autonomous turn is active.
- Candidate selection treats rapid software/integration status flapping,
  `unknown`/`unavailable` lifecycle transitions, and uncorroborated short
  sensor bursts as noise rather than household routine. They justify a
  proposal only when persistent or corroborated and materially relevant to
  household safety, comfort, resources, or reliability. The underlying events
  remain queryable; this is an observation-quality rule, not evidence deletion.
- Provider failures do not crash the HomeWorld process and are retried only on
  the next scheduled boundary. Shutdown cancels an observation through DSH's
  canonical cancellation path.
- A completed turn is reported as `proposal_created` or `no_proposal`; it is
  never mislabeled as merely `started`. Gating and redacted runtime failures
  remain separate outcomes.
- The scheduler exposes only metadata-safe local status: waiting/running/stopped,
  configured cadence, startup mode, and the last attempt time/outcome. The
  Inbox may render this status, but never the observation prompt, tool inputs,
  tool results, household state, or provider error text.
- The manual Inbox POST requires authentication, an exact same-origin request,
  and an empty bounded form body. It reuses every scheduler gate and audit path;
  it does not create a parallel Agent loop.

## Non-goals

This slice does not add event-triggered automation, background device control,
automatic approval, cron syntax, a second session, or a vendor-specific
observer. It does not guarantee that a model will find a useful proposal.
Its purpose is to connect the existing trustworthy loop to time without
expanding authority or silently spending model calls by default.

The acceptance test drives one scripted DSH observation through bounded
snapshot and evidence tools, Hub-owned proposal creation, and the Inbox on one
Cordis root. It asserts exact event provenance and confirms that application
remains unavailable.
