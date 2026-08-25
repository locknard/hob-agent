# Bounded temporal evidence

## Product reason

The Home Agent exists to turn household observations into trustworthy,
reviewable automation proposals. A current snapshot can answer "what is true
now", but it cannot establish that a behavior happened repeatedly. Treating
the bootstrap snapshot as history would let one startup observation masquerade
as a household habit.

The live read-only slice exposes recent changes that hob-agent itself observed
after a bridge completed a verified snapshot. A separate imported-history
slice can retain bounded platform history with explicit imported provenance.
Neither path runs an automation or grants authority.

## Evidence boundary

The Hub owns the evidence query. DSH receives only a governed tool over this
neutral result; it never reads SQLite or a bridge journal directly.

- Callers select one to 20 current hub capability IDs, never native IDs.
- Lookback is one to 168 hours and output is capped at 200 events.
- The journal query is SQL-bounded and matches only the selected current
  bindings.
- Only state events in the current verified epoch with a sequence after its
  `sync-complete` watermark qualify. Bootstrap state rows are not behavioral
  evidence.
- An adapter may suppress a native notification only when its newly projected
  neutral scalar attributes exactly equal the preceding neutral state for the
  same capability. Such native metadata-only churn never becomes a canonical
  event or Agent activity; actual neutral attribute and health changes remain
  ordered and journaled.
- Each event contains hub device/capability identity, optional semantic kind,
  a scalar `state` value, observation time, source-time quality, origin, and
  bridge epoch/sequence provenance. Raw attributes and native identifiers stay
  inside the Hub.
- Device names and state values remain untrusted household data.

## Honest coverage

Every involved bridge reports coverage independently. Coverage is `complete`
only when the requested window begins after the current verified baseline, the
bridge is ready, there is no relevant history gap, and neither the journal
query nor the final merge was truncated. Otherwise it is `partial` or
`unavailable` with closed reasons.

A resync creates a new epoch and therefore a new live-evidence baseline.
Earlier epochs are not silently joined to the current one. Imported evidence
uses its own exact import identity, source range, partial/unavailable coverage,
and retention-floor reason; it never becomes live evidence through fallback.

## Imported history replay

When an approved Proposal was prepared from imported history, the Hub freezes
its exact imported references and requested window. After compilation and the
current-world no-write dry-run pass, the preparation pipeline asks HomeWorld
for only those retained neutral samples. The fixed pure evaluator joins each
sample by `bridgeId + importId + historySeq`, evaluates supported
`capability_changed` triggers and scalar conditions in stable time order, and
writes an immutable `history-replay-attestation` in the Artifact assessment
lane.

Missing, drifted, truncated, or unavailable references produce an honest
unavailable assessment and fail the independent `history-replay` preparation
stage. Schedule triggers remain unavailable because imported state samples do
not contain a trustworthy historical clock event. A passed replay proves only
that the compiled neutral behavior matches the selected retained samples; it
does not prove that Home Assistant executed the automation, that the recorder
is complete, or that observed changes were causally produced by the rule.

## Causality evidence

An adapter may place one `causality@1` extension event after a live state event.
The Hub accepts the annotation only when `refSeq` names an accepted state in the
same epoch, remains within 32 sequence positions, and does not cross the
verified snapshot boundary. A rejected annotation enters the extension
rejection ledger without changing world state or the durable core watermark.

The Home Agent can query causality only for an exact capability and provenance
returned by the evidence tool. Its result contains a closed source category and
coverage reasons; principal, rule, artifact, native, and provider references
remain inside the Hub. An absent, unknown, stale, partial, or unavailable cause
stays explicit and never becomes a guessed explanation.

## Proposal relationship

This slice makes evidence inspectable; it does not make approval equivalent to
application. Proposal admission remains review-only and initializes the raw
Proposal `dryRun` field to `not_run`. After an exact Artifact preparation, the
Hub reports compiler and simulator facts separately through the exact
`ArtifactReviewSnapshot`; that attestation does not rewrite the raw Proposal
field. Hub-created proposals may attach exact bounded event references by
selecting current hub capability IDs and a lookback window. The Hub re-runs
this query; the model never supplies journal provenance. See
`docs/proposal-evidence-binding.md`.
