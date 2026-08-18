# Bounded temporal evidence

## Product reason

The Home Agent exists to turn household observations into trustworthy,
reviewable automation proposals. A current snapshot can answer "what is true
now", but it cannot establish that a behavior happened repeatedly. Treating
the bootstrap snapshot as history would let one startup observation masquerade
as a household habit.

The next read-only slice therefore exposes recent changes that hob-agent itself
observed after a bridge completed a verified snapshot. It does not import
vendor history, run an automation, or grant a new authority.

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

A resync creates a new epoch and therefore a new evidence baseline. Earlier
epochs are not silently joined to the current one. Later work may add an
explicit imported-history contract, but imported evidence must retain its
different provenance and confidence.

## Proposal relationship

This slice makes evidence inspectable; it does not make approval equivalent to
application. Proposal creation remains review-only and dry-run remains
`not_run` until a Hub-owned artifact compiler and simulator exist. Hub-created
proposals may attach exact bounded event references by selecting current hub
capability IDs and a lookback window. The Hub re-runs this query; the model
never supplies journal provenance. See `docs/proposal-evidence-binding.md`.
