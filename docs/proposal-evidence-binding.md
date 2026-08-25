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

## Imported recorder evidence (additive v1 rule)

The proposal v1 envelope may also carry an explicitly imported recorder
evidence source. This is an additive source label; existing v1 rows and the
existing live `post-baseline-event` source retain their meanings.

An imported reference has only neutral proposal metadata:

```ts
{
  bridgeId: BoundedId;
  hwId: BoundedId;
  capabilityId: BoundedId;
  observedAt: UtcTimestamp;
  source: "imported-history";
  origin: "imported";
  importId: BoundedId;
  historySeq: PositiveSafeInteger;
  sourceRange: { since: UtcTimestamp; until: UtcTimestamp };
}
```

`sourceRange` is the exact normalized `history@1` page range, not the range
of the proposal request or a query window invented after the fact. The
imported record identity is `(bridgeId, importId, historySeq, sourceRange)`.
An imported reference never carries live `epochId`, live `seq`, `liveCut`, a
state value, raw attributes, native/provider identifiers, or a cause claim.
The live watermark vector that remains on the envelope describes the current
Hub context only; it is not provenance for an imported record.

The envelope records imported coverage separately from live temporal coverage:
the object below is persisted as `evidence.importedHistory`.

```ts
{
  requestedSince: UtcTimestamp;
  requestedUntil: UtcTimestamp;
  truncated: boolean;
  coverage: readonly {
    bridgeId: BoundedId;
    status: "partial" | "unavailable";
    reasons: readonly ImportedHistoryCoverageReason[];
  }[];
}
```

`history@1` cannot prove a recorder retention floor or source completeness, so
imported coverage never becomes `complete`. Empty, partial, unavailable,
conflicted, or truncated history remains explicit; an empty or unavailable
coverage result may therefore have no imported references. Whenever imported
references are present, every referenced bridge appears in coverage with a
non-`unavailable` status. A durable history row that
predates source-range persistence has no exact range and is omitted from this
private proposal projection; the Hub never substitutes the current query
window.

The Hub selects imported references from its bounded history journal. Agent
and Product callers select only neutral capability IDs and a bounded lookback;
they never submit `importId`, `historySeq`, `sourceRange`, live watermarks, or
coverage claims. Recorder time, device overlap, and state-value proximity
never infer a cause; `automationTrace@1` remains an exact live-context read.

Imported references may coexist with current-state references, but imported
history and live post-baseline event references are separate evidence modes.
The Hub rejects a merge that would silently discard one mode. Existing live
retention collection continues to pin only live journal references; imported
history keeps its independent partition and retention semantics.

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
envelope change must use a new schema version. The `history@1` journal
migration adds nullable source-range columns transactionally and repeatably;
legacy rows with both columns absent remain readable as history but cannot
become proposal references until an exact range is available.
