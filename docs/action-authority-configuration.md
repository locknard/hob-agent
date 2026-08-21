# Local action-authority configuration

Status: Phase 0 decision for a Hub-private, startup-only configuration source.
It enables authority assessment and neutral compile/dry-run work; it does not
mount an executor, bridge control route, approval ticket, or Agent/Inbox write
surface.

## Decision

The Hub reads an optional private file at
`<HOB_DATA_DIR>/action-authority.json`. Authority configuration must not be
embedded in `HOB_BRIDGES`, model input, Artifact content, plugin output, or an
environment variable. The fixed data-directory path is the only Phase 0 path;
there is no path override or live reload.

A missing file means that no action authority is configured. Once a file is
present, an unreadable, symlinked, permission-wide, malformed, duplicated, or
unsupported file fails startup closed. The loader never falls back to an old
in-memory value.

The v2 file is strict JSON:

```json
{
  "version": 2,
  "bindings": [
    {
      "hwCapabilityId": "hwc-example",
      "bridgeId": "ha-main",
      "approved": true,
      "policyClass": "confirmation",
      "revision": 1
    }
  ]
}
```

Only those exact fields are allowed. `policyClass` is a required reviewed
execution class: `direct`, `confirmation`, or `administrator`. Onboarding may
suggest a class from a neutral semantic hint; the local human configuration
records the explicit class that production execution reads. `revision` is a positive safe integer
owned by the local human configuration workflow and is monotonic per
`hwCapabilityId`; it is not inferred from file metadata or array order. Each
capability appears at most once and selects exactly one bridge. An explicit
`approved: false` records a non-approved/revoked selection; an absent entry is
`not_configured`.

The file cannot contain a caller-provided digest, native or remote identity,
entity or service name, route, URL, credential reference, generation,
availability, schema claim, or provider payload. Duplicate JSON keys are
rejected before ordinary JSON parsing can apply last-key-wins behavior.

For each validated entry, the Hub computes `configIdentity` as a SHA-256 digest
of canonical bytes containing the exact v2 entry except `revision`, including
`policyClass`, under an `action-authority-config-v2` domain separator. The entry's explicit `revision`
becomes `configRevision`. Reordering entries therefore does not change any
candidate, while changing one capability's bridge, approval, or policy class affects only
that capability. Reusing a revision with different content is rejected within
one process/config load; durable candidate history later rejects replay of a
superseded identity.

## Filesystem boundary

The configured data directory and the file itself must be real filesystem
objects rather than symbolic links. The immediate data directory must be
owner-only (`0700`) and the file must be a regular owner-only file (`0600`).
The loader opens the file without following a final symlink, applies a bounded
byte limit before parsing, and returns only the coordinator map. It does not
write, repair, chmod, log content, or watch the file.

A future Hub-owned admin command may add atomic replace, expected revision,
human principal, approval reference, and append-only audit. Until that writer
exists, this source is an explicit local operator configuration, not a claim
that the in-memory governance proposal is durable approval.

## Authority and schema binding

The local file selects only a Hub `hwCapabilityId` and one configured bridge.
`HomeWorldService` still verifies that the capability and bridge binding
exist, the bridge remote identity is bound, the registration generation is
current, and the source is available. There is no fallback bridge.

The private authority binding digest must bind the selected capability's exact
adapter `schema` and `schemaVersion` in addition to bridge, native binding,
remote binding, space, and registration generation. A schema change already
produces a new `hwCapabilityId`; a version-only change keeps the stable
capability identity but supersedes the old authority candidate. Neither case
inherits executable authority silently.

The neutral candidate remains exactly:

```ts
{
  actionAuthorityCandidateId,
  hwCapabilityId,
  status
}
```

It carries no bridge, schema, native identity, route, or credential. Schema
action compatibility, opaque authority availability, and the future final
execution route remain three independent checks.

## TDD gate

Implementation tests must prove:

- missing default file yields an empty map, while every malformed present file
  fails closed without echoing content;
- symlinked data directory/file, wrong file type, non-`0700` directory,
  non-`0600` file, oversized input, duplicate keys, unknown fields, invalid
  IDs/revisions, and duplicate capabilities are rejected;
- entry ordering is identity-neutral, while bridge, approval, or revision
  changes have the documented per-capability effect;
- secret-, route-, native-, URL-, generation-, and schema-like additions are
  rejected rather than stripped;
- launch composition passes only the generated map into `HomeWorldService`;
  absent, unapproved, mismatched, and unavailable selections do not fall back;
- exact schema-version change modifies the private binding identity and
  supersedes the old candidate without changing the model-visible shape; and
- no loader, Agent tool, Inbox route, bridge adapter, or plugin gains a method
  to mutate this file or execute an action.
