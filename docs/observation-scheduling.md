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
- Provider failures do not crash the HomeWorld process and are retried only on
  the next scheduled boundary. Shutdown cancels an observation through DSH's
  canonical cancellation path.

## Non-goals

This slice does not add event-triggered automation, background device control,
automatic approval, cron syntax, a second session, or a vendor-specific
observer. It does not guarantee that a model will find a useful proposal.
Its purpose is to connect the existing trustworthy loop to time without
expanding authority or silently spending model calls by default.
