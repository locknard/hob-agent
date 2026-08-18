# Hub

The Phase 0 monolith: neutral bridge connectivity, append-only event ingestion,
world-model indexing, scheduling, and policy-enforced action boundaries.

`HomeWorldService` owns the configured bridge catalog, registry, ingest journals,
and adapter lifecycles. The DSH agent consumes only its neutral
`ctx.homeWorld` snapshot service; ecosystem adapters do not become Cordis
services.

Home Assistant and Xiaomi Home are peer ecosystem adapters behind the same
Bridge v6.3 contract. The built-in catalog always includes HA. Xiaomi is added
only when composition supplies an authorized `XiaomiHomeTransportPlugin`; the
default launch catalog fails closed instead of routing Xiaomi through HA or
pretending a fixture transport is production support. The hub-owned Xiaomi
adapter already defines MIoT property projection, identity, resync and
lifecycle semantics, while live cloud/gateway connectivity remains outside the
repository until an appropriately licensed SDK or written authorization is
available.

`HomeAgentRuntime` owns the single root Cordis context and mounts HomeWorld
before the DSH Home Agent. `pnpm start` requires the absolute durable
`HOB_DATA_DIR`, reads `HOB_BRIDGES`, `HOB_MODEL`, the selected provider
credential, and only the bridge credential env names declared by those entries.
Journal, registry, and world-model SQLite files are placed below that
directory; the launch path never silently falls back to `:memory:`.

`probeHomeAssistantEndpoint` is the credential-free onboarding preflight. It
reads only HA's initial `auth_required` challenge, returns version and latency,
sends no socket data, and fails after a bounded timeout.
