# Hub authority candidate registry

Status: accepted as the M3b/M3c prerequisite; implementation not yet present.

## Decision

Artifact authority assessment cannot reuse state authority, a Bridge route, or
an in-memory governance proposal ID. The Hub will own a private, durable
authority candidate registry. It gives Artifact assessment a stable opaque
candidate identity while keeping bridge, adapter, remote, and native identity
inside Hub execution boundaries.

An Artifact, Agent, Skill, plugin, Inbox, or bridge may see only:

```ts
type NeutralAuthorityCandidate = {
  actionAuthorityCandidateId: string;
  hwCapabilityId: string;
  status: "available" | "unavailable" | "not_approved";
};
```

This is an assessment result, not an action route or grant.

## Private durable record

The Hub-private row binds:

- a Hub-generated registry row ID and Artifact-facing candidate ID;
- one `hwCapabilityId`;
- an opaque binding identity derived inside Hub from the selected bridge
  registration generation and exact capability binding;
- an authority configuration identity, including approval and configuration
  revision;
- `active | superseded | revoked` lifecycle and append-only audit timestamps.

The private row may contain the internal information required to resolve a
route later. Its neutral projection and `authorityRegistryIdentity` are
irreversible digests and must not reveal bridge ID, adapter type, native ID,
remote instance, credential locator, or route.

## Identity and lifecycle

The same capability, configuration identity, binding identity, and bridge
registration generation must return the same candidate across restart and
concurrent resolution. Any of the following appends a new row and supersedes
the old candidate atomically:

- authority target, approval, or configuration revision changes;
- bridge registration generation or remote binding changes;
- capability binding identity changes;
- explicit revoke.

Watermark, epoch, liveness, freshness, or temporary availability changes do
not change the candidate ID. They change candidate status and the immutable
Artifact authority assessment identity. There is no fallback from an
unavailable configured authority to another bridge.

Unknown capabilities fail closed. A known capability with no configuration
may receive an `unavailable` placeholder candidate so the assessment can state
the missing authority without inventing a route. It cannot be compiled.

## Assessment seam

The Hub resolves the complete set of device-action capability references from
the immutable Artifact content, then obtains:

```ts
type AuthorityAssessmentInput = {
  authorityRegistryIdentity: `sha256:${string}`;
  candidates: readonly NeutralAuthorityCandidate[];
  checkedWatermarks: readonly ArtifactWatermark[];
};
```

Every device-action target must have exactly one candidate. The registry
identity, candidate IDs/statuses, scope, and checked watermarks all contribute
to `ArtifactAuthorityAssessment.inputIdentity`. A missing registry, corrupt
row, incomplete scope, stale binding generation, or absent relevant watermark
prevents an available assessment.

Before M3d ticket claim, Hub resolves the latest candidate again to a final
route and checks the same binding/config generation. The final route never
enters Artifact bytes or model-visible context.

## Persistence and conformance gates

- private SQLite main/WAL/SHM files remain mode `0600`;
- row append, prior-row supersede, operation identity, and audit commit in one
  `BEGIN IMMEDIATE` transaction;
- deterministic replay and two-connection concurrency produce one active row;
- corruption, missing history, or ambiguous active rows fail closed rather
  than silently rebuilding the old identity;
- rebind/config/revoke tests prove old assessments become stale;
- serialized neutral output is checked for bridge/native/remote/adapter fields;
- this registry exposes no control, credential, bridge call, or execution
  method and does not enable an action plane by itself.

