# Neutral bridge contract (v6.4)

This directory is the single source of truth for the v6 neutral bridge
boundary from [`docs/bridge-design.md`](../docs/bridge-design.md), plus the
additive v6.4 semantic-kind decision in
[`docs/capability-semantics.md`](../docs/capability-semantics.md). Zod
schemas are the runtime contract; exported value types are inferred from those
schemas where a runtime boundary exists. Ecosystem-native payloads must be
projected into these shapes before they reach hub or agent-layer code.

## Entry points

- `bridge-contract.ts` is the canonical implementation.
- `bridge-contract-v6.ts` is the sole explicit frozen-version entry point and
  `index.ts` is the package entry point; both re-export the canonical
  implementation. There is no legacy v0 contract entry point.

The package depends on `zod` at the workspace root. Consumers should import
both the schema they need (for example `envelopeSchema`) and its inferred type
(for example `Envelope`) from one of the entry points above.

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
  read-only `semanticKind`, `StateEvent`,
  `SnapshotManifest`, `IngestRecord`, and bounded `HubBridgeDiagnostics`.
- Closed `CoreReasonCode` and `ControlResult` schemas. Ecosystem-specific
  `adapterCode` values remain bounded diagnostic data and cannot add core
  result statuses or reasons.
- Open extension declarations (`id`, semver `version`, optional JSON metadata)
  and `ExtensionHandleRegistry`, an intentionally empty interface for module
  augmentation. `canonicalExtensionKey()` produces the shared `<id>@<major>`
  key used by declarations, handles, and `ext` envelopes.
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
