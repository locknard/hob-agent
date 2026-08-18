# Trusted proposal evidence binding

Status: accepted for Phase 0 implementation.

## Decision

The model may select up to 20 current neutral hub capability IDs and a bounded
lookback window when it creates a proposal. The Hub re-runs the temporal
evidence query and attaches the resulting event references to the durable
proposal envelope.

Each post-baseline event reference records only:

- neutral bridge, device, and capability IDs;
- observation time; and
- the Hub-verified bridge epoch and journal sequence.

The proposal also stores the bounded query window, truncation flag, and the
per-bridge coverage result and closed reasons. It does not copy state values,
raw attributes, native IDs, or model-authored provenance into the Inbox.

Current-state-only proposals remain possible. Their references are explicitly
marked as current state and do not claim behavioral coverage.

## Trust boundary

- DSH expresses intent and selects current hub identities; it never supplies an
  epoch, sequence, coverage result, bridge watermark, or conflict result.
- The Hub validates that selected capabilities belong to the selected devices
  in the current snapshot before querying evidence.
- The Hub uses the same SQL-bounded, post-`sync-complete` evidence path as the
  read-only inspection tool, with a proposal maximum of 50 event references.
- Empty, partial, unavailable, or truncated evidence is preserved honestly.
  It is not promoted to complete evidence and does not block human inspection.
- Proposal approval remains review metadata only and still cannot apply an
  automation or control a device.

## Compatibility

The added evidence provenance and coverage fields are optional additions to
the proposal v1 envelope so existing local v1 rows remain readable. New
Hub-created drafts always label their reference source. A future incompatible
envelope change must use a new schema version.
