# Canonical ingest-journal retention

Status: implemented as an explicit, per-bridge SQLite journal operation.

`SqliteIngestJournal.applyRetention(policy)` is the only retention entry
point. It does not run from a timer and it does not infer permission to delete
history from quota pressure. A caller supplies a bounded policy id, operator,
reason, and decision timestamp. Reusing a policy id fails closed.

## Required preservation rules

For the requested bridge, one operation:

- keeps every event in the latest manifest-verified
  `consistentWatermark` epoch through that watermark;
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

## Conservative limits in this slice

The existing rejection, history-gap, and compressed-heartbeat tables do not
carry a receipt timestamp. This slice therefore never deletes those metadata
rows; retaining them is safer than guessing a time window. A future schema
revision may add an auditable metadata-retention policy, but it must preserve
open gaps and rejection presence first. There is also no automatic retention
scheduler or proposal-store callback yet: the owning service must call the
explicit operation with the references it has verified.
