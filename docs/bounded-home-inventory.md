# Bounded home inventory discovery

## Evidence

The real Phase 0 HA household contains roughly 75 devices and 779 capability
instances. A detailed `get_home_snapshot` page is intentionally limited to 20
devices and includes current state plus capability identities. Reading the
whole home through that detailed surface is unnecessarily expensive, while
reading only the first page lets alphabetical ordering bias an observation.

## Decision

The Home Product Bundle contributes a second read-only DSH tool,
`get_home_inventory`, for discovery before detailed inspection. It pages up to
50 compact device summaries containing only:

- opaque Hub device identity and optional display name;
- validity, contributing neutral bridge IDs, and accepted Hub space IDs;
- the unique closed semantic kinds present on the device; and
- capability and current-state counts.

Each page includes only its referenced neutral spaces plus the aggregate
topology. It omits current values, capability IDs, adapter schemas, native
device/entity/property/space IDs, URLs, credentials, and bridge errors.

An unfiltered observation must follow the inventory cursor until exhausted
before it treats discovery as household-wide. It then uses exact Hub IDs with
`get_home_snapshot` for a small candidate set and uses bounded temporal
evidence before claiming behavior. Partial inventory coverage cannot support a
whole-house conclusion or proposal.

`requestObservation()` activates a runtime coverage gate. The gate accepts only
a sequence starting without a cursor, continuing with the exact returned
cursor, and retaining the same opaque inventory version and total device count
until no next cursor remains. The version hashes only the already-neutral
compact inventory shape and is unaffected by changing current state values.
While that autonomous gate is active, `create_home_proposal` fails closed until
the sequence completes. A new first page may restart an invalidated sequence.
The gate ends with the observation, so a separate explicit user conversation
about known Hub device IDs is not forced into a whole-house scan.

This is an internal DSH tool addition, not a bridge-contract revision. The Hub
continues to own the normalized HomeWorld snapshot and every proposal-time
evidence and conflict check.
