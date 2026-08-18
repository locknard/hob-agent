# Bounded home snapshot query

Status: accepted for Phase 0 implementation.

## Decision

The hub continues to own one complete, deterministic neutral HomeWorld
snapshot. The DSH `get_home_snapshot` tool exposes a bounded view of that
snapshot rather than returning every device on every call.

The tool supports:

- deterministic device pagination by opaque `hwId` cursor;
- exact selection by opaque `hwId`;
- filtering by neutral `hwSpaceId` and closed `semanticKind`; and
- a default page of 10 devices and a hard maximum of 20 devices.

Filtering is applied to capability bindings. Returned device bindings, states,
and spaces are reduced to the selected capabilities and bindings. Bridge
watermarks and aggregate health metrics remain present so the caller can judge
freshness and consistency. Page metadata reports the number of matched and
returned devices and the next cursor, if one exists.

## Why now

The first real HA aggregate used during development contains 75 neutral
devices, 779 capability bindings, and 540 current states. Returning that entire
projection in one model tool result is needlessly expensive and makes relevant
household context harder to identify. A bounded query lets the agent first
locate a space or semantic class and then inspect only the relevant slice.

Only aggregate counts informed this decision. Household names, native IDs, and
state values are not recorded here.

## Boundaries

- This is an agent-boundary projection, not a second HomeWorld store or index.
- The complete `projectHomeSnapshot` function remains available as a pure Hub
  facade projection for deterministic tests and non-model consumers.
- Filters select information only. They do not grant action authority, infer
  cross-bridge identity, or change proposal and approval policy.
- Pagination order is the normalized `hwId` order. The cursor is exclusive and
  opaque to the model except for passing it back unchanged.
- Invalid or oversized arguments fail closed instead of being silently widened.
- Names and current state remain untrusted data even when selected by a filter.

## Follow-up

After bounded discovery is available, proposal creation should attach trusted
evidence provenance selected by the Hub rather than accepting model-authored
journal sequence identifiers.
