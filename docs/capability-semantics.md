# Capability semantics v6.4

## Evidence and problem

An early aggregate-only read of the development Home Assistant instance on
2026-08-19 found 75 valid devices, 540 current states, 779 capabilities, one
ready bridge watermark, no history gap, and 15 raw automation entities. Every
capability still used the adapter schema `ha.entity`. The largest entity-domain
groups were sensors (420), switches (76), binary sensors (70), buttons (69),
and numeric controls (66). No household names, identifiers, or state values are
recorded here.

The later committed neutral cut still contains 75 devices, 540 states, and 779
capabilities. Its `foreignRules@1` catalog exposes 12 configured rules after
unavailable restored placeholders are excluded. The difference is filtering
semantics, not evidence that three household rules were deleted.

Schema provenance is correct but insufficient for a useful cross-ecosystem
Home Agent. It cannot reliably group a light and a sensor without importing HA
or MIoT vocabulary into the agent layer.

## Additive contract decision

Bridge contract v6.4 adds an optional per-instance `semanticKind` to
`AdapterCapabilityRef`. The closed initial vocabulary is:

`light`, `switch`, `button`, `sensor`, `binary-sensor`, `numeric-control`,
`choice-control`, `text-control`, `time-control`, `event`, `media`, `cover`,
`lock`, `presence`, `fan`, `camera`, `vacuum`, `climate`, `weather`, and
`automation`.

This is a read-side classification hint with adapter provenance. It does not:

- replace or weaken the adapter-owned schema and attrs validation;
- claim two capability instances are equivalent;
- enable automatic identity or capability binding;
- imply that an observation is writable; or
- grant action, artifact, approval, or execution authority.

The original schema, schema version, native binding, hub capability identity,
and source bridge remain visible. Unknown or ambiguous capabilities omit the
hint. The Hub and Agent must never invent a fallback classification.

## Adapter qualification

The HA adapter derives a hint only from the stable entity-domain prefix that it
already consumes while building a descriptor. Device class is not required;
the observed registry did not provide it consistently. Unmapped domains remain
unclassified.

The Xiaomi bridge cannot infer semantics from `siid`/`piid`, primitive format,
or writability. An authorized transport may provide a validated semantic kind
only when it has resolved the MIoT specification. The neutral adapter passes
that bounded claim through; absent metadata remains unclassified.

`EquivalenceMapping` stays inactive. A later reviewed mapping may relate
adapter schemas or propose cross-bridge capability binding, but semantic hints
alone are never sufficient for that decision.
