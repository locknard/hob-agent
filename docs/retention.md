# Canonical ingest-journal retention

Status: implemented as an explicit, per-bridge SQLite journal operation and
mounted in the production Hub. The local operator facade exposes aggregate
preview only; apply remains unavailable until incomplete-epoch preservation and
cross-database proposal-pin races have a separately reviewed solution.

`SqliteIngestJournal.applyRetention(policy)` is the only journal-level
destructive entry point. It does not run from a timer and it does not infer
permission to delete history from quota pressure. At this boundary, a caller
supplies a bounded policy id, operator, reason, and decision timestamp.
Reusing a policy id fails closed.

`SqliteIngestJournal.previewRetention(policy)` evaluates the same candidate and
protection decision under a SQLite read-transaction snapshot, but never deletes
an event, changes logical capacity or coverage, or writes an audit row. Preview
is informational rather than a reservation. A future apply must use a fresh
locked decision and may report different counts if bridge evidence, gaps,
watermarks, or durable proposal pins changed after preview. The local operator
command rejects every apply flag and confirmation setting. Preview is not
exposed to the Agent, Inbox HTTP, Skills, plugins, or bridge adapters.

## Required preservation rules

For the requested bridge, one operation:

- keeps every event in the latest manifest-verified
  `consistentWatermark` epoch through that watermark;
- keeps every event in an epoch that has never reached manifest-verified
  consistency; historical consistency is recorded per exact bridge and epoch,
  and an upgraded database backfills only the currently proven watermark;
- keeps every event in an epoch with an open `history-gap`;
- keeps every event named by the caller's durable proposal-evidence
  references (`bridgeId`, `epochId`, and sequence);
- keeps all events inside the default 168-hour evidence window; and
- deletes only older, unprotected canonical event rows.

The evidence window can be widened only through an explicit, bounded
`evidenceWindowMs` policy field (maximum one year); policies shorter than 168
hours are rejected. The default is 168 hours. A malformed timestamp, sequence,
bridge, or unbounded reference list is rejected before the journal is changed.

Proposal storage remains the owner of proposal rows. The journal deliberately
accepts verified sequence references as a small pinning seam; it does not read
or enumerate proposal contents and it does not copy state values into the
retention audit.

The Hub-owned `HomeRetentionService.retain(request)` is the explicit product
entry point. It accepts a bridge, a bounded reason, an optional evidence window,
and `requestedBy` from a trusted in-process operator context only. `requestedBy`
is not an HTTP, agent, or UI input in this phase. The service generates
`requestedAt` from its injected clock and derives the policy id, so a caller
cannot move the evidence window into the future or supply a policy timestamp.
It never accepts proposal references. The service asks `HomeProposalService`
for a durable, bridge-filtered projection of exact `post-baseline-event`
references. The proposal store holds a SQLite write lock while the projection
callback runs, so proposal creation/review cannot commit between evidence
collection and the journal's retention transaction. This callback is a
synchronous seam: an async/Promise callback is rejected before commit. The
projection contains only `{ referenceId, bridgeId, epochId, seq }`; proposal
title, summary, rationale, notes, and other text never enter the retention
path. The projection and policy are capped at 1,000 references.

## Atomic audit and coverage

Deletion, the retention audit row, and recalculation of the logical byte ledger
run in one `BEGIN IMMEDIATE` transaction. The ledger is derived from each
row's bounded `bytes` column, so a restart recomputes the same value from the
committed rows. SQLite page reclamation (`VACUUM`) is intentionally not part
of this operation.

Each policy writes an immutable audit row containing the policy decision,
protected/deleted counts, bytes deleted, evidence-window start, and the
post-operation coverage floor. `journal.coverage(bridgeId)` reports:

- `coverageFloor`: the oldest retained canonical event timestamp, when one
  exists;
- `partial`: whether this bridge has had logical history deleted;
- the latest consistent watermark; and
- the number of open history gaps.

Consumers must treat `partial: true` as incomplete historical coverage. An
empty result after deletion is not reported as a quiet, complete bridge.

`HomeRetentionService.status()` is the read-only operational seam for the
local Control Center. It queries only journal capacity, aggregate coverage,
and one bounded latest-audit lookup: per-bridge and aggregate logical bytes,
complete/partial/degraded coverage, coverage floor, and the latest applied
time/result/bytes deleted. It never reads event rows, proposal text, or device
state values, and it does not expose the internal policy id. A bridge with no
audit is displayed as **Not run yet**; that is not an error when its coverage
is complete and capacity remains available. Partial/degraded coverage or an
exhausted capacity is shown as attention. Capacity reaches an early-warning
attention state at the fixed 90% used/max threshold; zero or invalid maxBytes
is unavailable rather than presented as healthy. The Control Center places
this report in native details and has no retention button, HTTP mutation,
Agent tool, timer, or automatic deletion path.

The Home Agent Cordis runtime mounts this service as `homeRetention` after
the durable proposal service and HomeWorld. It performs no work at startup and
owns no timer or scheduler. The authenticated product reads this service only
through its bounded projection.

The standalone local operator facade opens only the explicitly configured
bridge journal and proposal database for the duration of one command. It does
not start HomeWorld, connect a bridge, load a model, mount DSH, or read event
payloads for output. Its result projection is aggregate-only and omits the
internal policy id. The facade cannot apply retention. A future destructive
operator action must never be invoked automatically during validation,
startup, quota pressure, or a preview run.

## Conservative limits in this slice

This policy governs the per-bridge canonical ingest journal only. The separate
world-model raw-copy retention method does not share these bridge, epoch, gap,
proposal-pin, or preview guarantees and is not invoked by the operator facade.
It must remain unavailable as a production maintenance action until it has its
own reviewed preservation contract; canonical retention must not silently
chain into it.

The existing rejection, history-gap, and compressed-heartbeat tables do not
carry a receipt timestamp. This slice therefore never deletes those metadata
rows; retaining them is safer than guessing a time window. A future schema
revision may add an auditable metadata-retention policy, but it must preserve
open gaps and rejection presence first. There is no automatic retention
scheduler. Repeating the same bounded request with the same generated clock
instant derives the same policy id and is rejected by the journal's immutable
audit key after the first committed run; calls at later instants are distinct
decisions by design.
