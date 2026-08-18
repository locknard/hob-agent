# Neutral space topology v6.5

## Evidence and product need

The development Home Assistant instance reported seven areas during the
aggregate-only 2026-08-19 read. The current neutral bridge projection discards
that topology, so the Home Agent can classify a light and observe its changes
but cannot know which household space the observation belongs to. No area
names or identifiers are recorded in this document.

Rooms are household context, not adapter authority. The bridge contract v6.5
therefore adds an optional adapter space reference to each capability instance
and a Hub-owned neutral space identity to each resulting world binding.

## Contract shape

- `AdapterCapabilityRef.space` carries a bounded adapter-native space ID and an
  optional display name.
- The Hub converts each `(bridgeId, nativeSpaceId)` binding into a stable opaque
  `hwSpaceId` and exposes a `WorldSpace` catalog.
- `WorldCapabilityBinding.hwSpaceId` relates the location to that particular
  source binding. It is not stored once on the whole capability, because a
  later reviewed cross-bridge capability binding may have different space
  provenance on each side.
- Unknown space or missing metadata remains absent. Neither Hub nor Agent
  invents a room from a device name.

The bounded Home Agent snapshot reports aggregate topology coverage: space
count, total device count, devices with exactly one accepted space, devices
without an accepted space, and devices with multiple accepted spaces. These
three device counts are mutually exclusive and sum to the total. This makes
incomplete or ambiguous household mapping explicit without revealing
additional names or identifiers and without inventing assignments.

Space names and device names are untrusted household data. A space reference
does not grant device, action, artifact, approval, or filesystem authority.

## Cross-bridge identity

Two bridges that both report a room named "Living room" receive distinct
`hwSpaceId` values. Names are neither globally unique nor sufficient proof of
physical equivalence. Automatic name-based merging is forbidden. A future
space-link proposal may join them after human review; v6.5 does not add that
mutation.

## Adapter qualification

Home Assistant entity-area assignment takes precedence over the containing
device's area; otherwise the device area is inherited. The area registry may
provide the display name. The adapter emits neither the HA registry object nor
other native topology fields.

The Xiaomi bridge accepts optional device-space metadata only from an
authorized transport. The neutral adapter applies that reference to each MIoT
property binding after validation. It does not infer a room from device names,
home IDs, or cloud ordering.
