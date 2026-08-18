# Neutral spatial applicability

Status: accepted for Phase 0 implementation.

## Problem found in the real-home pilot

The first aggregate Home Assistant cut contained 75 neutral devices. Only 25
had one accepted space binding, but 29 of the remaining 50 were explicitly
marked by the source registry as service entries. Treating all 50 as missing
room assignments would turn household onboarding into platform cleanup and
would teach the Agent that every software or whole-home object must live in a
room.

## Decision

- Space binding and spatial applicability are separate facts. A device can be
  located in one space, have conflicting locations, have an unknown location,
  or be explicitly non-spatial.
- The bridge core remains unchanged. Adapters may publish the generic
  `orgHints@1` stream extension in the same epoch as the device replay.
- The first closed payload admits only `{ nativeId, spatialDisposition:
  "non_spatial" }`. Missing hints mean unknown; adapters must never infer this
  disposition from a name or capability kind.
- Home Assistant emits the hint only for registry devices whose structured
  `entry_type` is exactly `service`. Other ecosystems may emit the same neutral
  fact only from an equally explicit source signal.
- The Hub validates, journals, and binds the hint to the committed epoch before
  projecting it onto a Hub device. A cross-bridge merged device is non-spatial
  only when every contributing binding says so and none has a space.
- The home-map draft separates explicitly non-spatial objects from genuine
  placement questions. The hint remains reviewable and cannot grant action
  authority, alter identity, or become behavioral evidence.

This is an additive bridge extension, not a Home Assistant field in HomeWorld
or the Agent API. It follows the `orgHints` seam already reserved by the v6
bridge design.
