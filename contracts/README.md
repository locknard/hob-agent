# Neutral bridge contract (v6.5)

This directory is the single source of truth for the v6 neutral bridge
boundary from [`docs/bridge-design.md`](../docs/bridge-design.md), plus the
additive v6.4 semantic-kind decision in
[`docs/capability-semantics.md`](../docs/capability-semantics.md) and v6.5
space-topology decision in
[`docs/space-topology.md`](../docs/space-topology.md). Zod
schemas are the runtime contract; exported value types are inferred from those
schemas where a runtime boundary exists. Ecosystem-native payloads must be
projected into these shapes before they reach hub or agent-layer code.

## Entry points

- `bridge-contract.ts` is the canonical implementation.
- `index.ts` is the sole package entry point and exports the canonical core,
  adapter conformance helper, actions, foreign-rules and organization-hints
  surfaces. Consumers use `@hob/bridge-contract` so the workspace dependency
  graph preserves the future process boundary.
- `bridge-adapter-conformance.ts` is an opt-in test helper exported from the
  package entry point. It is not a second runtime or ingest implementation.

The package declares its own `zod` dependency. Consumers import both the schema
they need (for example `envelopeSchema`) and its inferred type (for example
`Envelope`) from `@hob/bridge-contract`.

## Frozen Step 0 surface

The implementation covers the self-contained Appendix A baseline and the
frozen core surfaces:

- `BridgeInfo`, `BridgeAdapter`, `BridgeControl`, and generic
  `AdapterRegistration<C>`/`AdapterFactoryContext<C>`; factory construction is
  synchronous and receives a bridge-scoped `BridgeCredentialProvider`.
- Epoch/sequence `Envelope` and the complete core `BridgeEvent` union,
  including sync boundaries, health, heartbeat, and the canonical-keyed `ext`
  event shell. `sync-start` carries both the snapshot boundary and the stable
  `remoteInstanceId`; the pure factory therefore does not have to invent
  remote identity in `BridgeInfo`.
- `DeviceDescriptor`, `AdapterCapabilityRef` with an optional closed
  read-only `semanticKind` and adapter space reference, Hub-owned `WorldSpace`,
  `StateEvent`,
  `SnapshotManifest`, `IngestRecord`, and bounded `HubBridgeDiagnostics`.
- Closed `CoreReasonCode` and `ControlResult` schemas. Ecosystem-specific
  `adapterCode` values remain bounded diagnostic data and cannot add core
  result statuses or reasons.
- Open extension declarations (`id`, semver `version`, optional JSON metadata)
  and `ExtensionHandleRegistry`, an intentionally empty interface for module
  augmentation. `canonicalExtensionKey()` produces the shared `<id>@<major>`
  key used by declarations, handles, and `ext` envelopes.
- `bridge-org-hints.ts` defines the first closed `orgHints@1` stream payload:
  an explicit, bounded `non_spatial` disposition that remains a hint and never
  changes identity or authority.
- Closed identity-claim provenance (`device_reported`,
  `independent_registry`, `platform_registry`, or `inferred`) and bridge-scoped
  credential materials (`secret_text`, `oauth`, and `certificate`). The
  provider interface intentionally exposes only `resolve` and non-secret
  `describe`; it has no enumeration or vault access operation.
- `SchemaRegistration`, `ResourceBudget`, `EquivalenceMapping` placeholder,
  and `WorldCapability` for catalog admission and hub-assigned world identity.
- `BridgeStreamError`/`bridgeStreamErrorSchema` and
  `normalizeBridgeStreamError()` for the closed stream termination taxonomy.
  Unknown thrown values normalize to `internal_error`; only an explicit
  `protocol_error` is a protocol violation.

Schemas are strict for core objects and reject unknown fields. Extension
payloads remain `unknown` by design: the core only validates their envelope and
canonical extension key; an enabled extension owns its payload schema.

## Adapter conformance helper

Third-party adapter tests can call `runBridgeAdapterConformance()` with one
deterministic registration fixture. The report covers:

- registration schema, adapter type and hub-assigned bridge identity;
- synchronous factory construction and the observable purity boundary that
  forbids credential reads during construction;
- Zod config validation and bridge-scoped credential alias/kind checks,
  including aliases actually read by the adapter, without retaining material in
  the report. The wrapper fail-closes undeclared aliases and kind mismatches by
  returning no material to the adapter;
- the first replay through `sync-start` and `sync-complete`, including epoch,
  sequence, remote instance identity, and manifest counts. Exact identity
  strings are preferred; a deterministic regular-expression expectation is
  available for adapters whose IDs include a monotonic process-local suffix;
- declared extension canonical keys and expected handle availability;
- an adapter-supplied stream-error probe normalized to the closed taxonomy;
- `requestResync()` result validation and terminal `dispose()` execution for
  every adapter instance constructed by the probes; any disposal failure fails
  the report.

The adapter public seam is checked with a local strict projection of
`{info, events, control, extension}`, so class-backed adapters with private
runtime fields remain testable without changing the frozen contract schema.

The helper deliberately stops at the first `sync-complete`. It does not journal,
deduplicate, fold state, run reducers, schedule retries, or implement any
action surface. Those behaviors remain hub-owned and must retain their own
integration tests. Factory purity is necessarily an observable boundary: the
helper detects asynchronous factories and credential-provider calls, but cannot
prove arbitrary synchronous I/O performed by trusted in-process code.

```ts
const report = await runBridgeAdapterConformance({
  registration,
  adapterType: "example",
  bridgeId: "bridge-example",
  config,
  credentials,
  replay: {
    epochId: "epoch-1",
    snapshotId: "snapshot-1",
    remoteInstanceId: "remote-1",
    deviceEnvelopeCount: 0,
    stateEnvelopeCount: 0,
  },
  extensionHandles: [],
});

if (!report.passed) throw new Error("adapter conformance failed");
```

## Module augmentation

Extension packages may register typed handles without changing this core
package:

```ts
declare module "@hob/bridge-contract" {
  interface ExtensionHandleRegistry {
    "actions@1": ActionsExtension;
  }
}
```

The extension key is intentionally closed at each consuming build through the
augmentation, while the declaration array and event payload remain open to
future extension packages.
