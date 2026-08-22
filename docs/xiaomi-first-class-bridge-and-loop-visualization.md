# Xiaomi first-class bridge and DSH loop visualization

Status: accepted and first slice implemented, 2026-08-19. The neutral bridge
contract remains frozen. This decision does not weaken the Phase 0 read-only or
single-runtime boundaries.

## Decision

Xiaomi Home is a first-class ecosystem adapter beside Home Assistant, not a
special projection extracted from HA:

```text
Xiaomi-authorized transport -> XiaomiHomeBridgeAdapter -> BridgeAdapter v6.3
Home Assistant WebSocket    -> HomeAssistantBridgeAdapter -> BridgeAdapter v6.3
                                                     \-> HomeWorld -> DSH Agent
```

The two adapters share only the neutral bridge contract. Neither imports,
controls, or falls back through the other. A device visible through both
adapters remains two bindings whose identity/authority is governed by
HomeWorld.

The DSH loop remains the only agent loop. Visualization is a read-only
projection of its canonical session events; it is not a second execution log
or an alternate runtime.

## License and authorization boundary

The official Xiaomi Home HA integration is useful architectural evidence, but
its license grants use only for non-commercial Home Assistant purposes and
explicitly does not authorize using the work to develop another application,
Web service, or other software. It also describes the related Xiaomi cloud API
interfaces as part of the licensed work. Therefore hob-agent must not copy or
translate that implementation, its private endpoints, certificate flow, or
protocol constants.

Permitted work before Xiaomi authorization:

- model MIoT-Spec-V2 concepts from public specifications;
- define a hob-owned transport port and canonical adapter projection;
- implement deterministic fixture/conformance transports and tests;
- implement credential, resource, lifecycle, and redaction boundaries;
- prepare product registration that remains unavailable without an authorized
  transport implementation.

Live Xiaomi cloud or central-gateway transport requires one of:

1. an official Xiaomi developer/partner SDK and terms that permit this product;
2. written authorization and issued client credentials for the required APIs;
3. a separately licensed public protocol/SDK whose terms cover this use.

Using undocumented endpoints, extracting app tokens, importing HA's stored
Xiaomi credentials, or embedding the HA integration as a sidecar are rejected.
They would be insecure, legally ambiguous, and would make Xiaomi subordinate to
HA rather than a peer.

Evidence reviewed:

- Xiaomi official integration repository and license at commit
  `1a5f890cbe08d14ec7252196bd925a57090e8774`:
  <https://github.com/XiaoMi/ha_xiaomi_home>
- MIoT-Spec-V2 device/service/property model and the official integration's
  published cloud-MQTT/local-gateway architecture:
  <https://github.com/XiaoMi/ha_xiaomi_home#principle-of-messaging>

No Xiaomi source code is copied into this repository.

## Xiaomi adapter boundary

### Adapter type and configuration

The catalog adapter type is `xiaomi-home`. Non-secret configuration contains
only stable product choices:

- region/cloud realm;
- selected home identifiers or an explicit allowlist;
- transport mode requested from the installed authorized transport;
- bounded heartbeat and bootstrap limits.

OAuth tokens, client secrets, user certificates, and private keys enter only
through declared bridge credential aliases. Account passwords and imported HA
configuration are never accepted.

### Internal transport port

`XiaomiHomeTransport` is a hub-internal trusted-code seam, not a new public
bridge contract. It provides:

- stable remote account/installation identity after authentication;
- one bounded bootstrap of homes, devices, MIoT specs, property values, and
  reachability;
- one cancellable ordered stream of property/event/online changes;
- resync and disposal;
- structured, redacted failure classes.

The adapter owns conversion from this native port to `BridgeAdapter v6.3`.
Cloud MQTT/HTTP and mainland central-gateway MQTT are future transport
implementations behind the same port; transport preference never changes the
canonical device identity.

### Canonical identity and schema

- `nativeId`: stable Xiaomi device DID, never display name.
- `nativeInstanceId`: MIoT instance identity derived from service/property
  identifiers, such as `service:<siid>/property:<piid>`.
- identity claim: Xiaomi DID may be emitted as `miotDid` with
  `platform_registry` provenance; stronger physical claims require an
  independently qualified source.
- schemas: owned `miot.*` namespace registered by `xiaomi-home`; schema
  admission is catalog-based, not inferred from arbitrary URN text.
- `remoteInstanceId`: opaque hash of the authorized account realm and stable
  installation identity, never a token or mutable nickname.

Bootstrap emits a full epoch and manifest. Incremental property changes emit
absolute state snapshots. Device online changes emit `device-health`; transport
health emits `bridge-health`/heartbeat. Native payloads and MIoT vendor metadata
do not cross the adapter boundary.

Actions remain disabled in this slice. Xiaomi control is introduced only with
the frozen actions extension, action authority, approval, idempotency, and
audit path.

## First implementation milestones

1. Add MIoT-native types, resource budgets, and a deterministic conformance
   transport in tests.
2. Implement `XiaomiHomeBridgeAdapter` over the internal transport port:
   bootstrap, incremental state, health, resync, cancellation, and disposal.
3. Register `miot.*` schemas and prove HA/Xiaomi coexistence through the same
   product bundle and HomeWorld snapshot.
4. Keep production `xiaomi-home` registration fail-closed until an authorized
   live transport is installed; configuration must not pretend fixture support
   is product support.
5. After Xiaomi authorization, implement the selected official transport and
   OAuth/certificate onboarding as a separate reviewed milestone.

## DSH loop visualization slice

DeepSeek Harness models visualization from its canonical append-only session
events. The reviewed upstream at commit
`99f6f02fecdb7dff40c3fbc9470f5907c29f74ca` uses a session event stream plus a
trajectory projection and renders turns, steps, assistant activity, tool calls,
results, timing, and token usage. Relevant upstream packages include
`dsh-session`, API event streaming, and `dsh-client-ui-trajectory`:
<https://github.com/deepseek-ai/deepseek-harness>.

Hob-agent should borrow these semantics, not vendor the current rapidly moving
Web UI:

- subscribe to DSH `session/event`, the source already owned by the loop;
- project stable rows keyed by session id + event seq or tool call id;
- group rows by turn and step;
- pair `tool/call` and `tool/result` by call id;
- expose duration, terminal reason, token usage, and tool status;
- retain a bounded tail and an explicit truncation marker;
- default to metadata-only summaries: no prompt text, reasoning text, tool
  arguments, tool results, credentials, device names, or household state;
- allow a local, explicitly authorized details view later; never export
  telemetry by default.

The neutral `AgentLoopTraceService` projection has a serializable snapshot and
deterministic tests. `inbox-web` owns a pure, accessible timeline fragment
renderer and mounts the bounded slice only on the selected proposal. The
projection is a review-only read model. Model context stays sourced from the
governed household evidence path.

## Implemented first slice

- `XiaomiHomeBridgeAdapter` projects authorized native transport snapshots,
  property changes, reachability, resync and lifecycle into the v6 base. The
  additive v6.5 path also accepts validated device-space metadata from that
  transport and applies it to property bindings without inferring rooms.
- `createBuiltinBridgeProductBundle({ xiaomi })` registers Xiaomi beside HA;
  the default executable catalog omits it and therefore rejects Xiaomi configs
  until a live authorized transport is installed.
- `AgentLoopTraceService` subscribes to DSH session lifecycle/events and exposes
  bounded metadata-only traces through the sole `DshHomeAgentService`.
- `renderAgentLoopTimeline` renders turns, steps, household-readable checks,
  timing and progressively disclosed aggregate token usage. Its public shape is
  limited to bounded operational metadata.
- Proposal detail resolves its stored DSH root tool-call ID to one exact turn
  and renders only that turn's steps, checks, timing, and model-token usage under
  “这条建议怎么得来的”. Each proposal therefore shows its exact bounded cost.
- The Xiaomi cloud/gateway transport slot remains reserved for an authorized
  implementation with an explicit source license and permission record.

## Acceptance gates

- HA and Xiaomi adapters pass the same synthetic bridge protocol matrix.
- Agent and HomeWorld core contain no HA- or Xiaomi-native payload vocabulary.
- Xiaomi bridge construction performs no I/O; one adapter instance has one
  event subscription lifecycle.
- No Xiaomi secret appears in bridge config, logs, journal, diagnostics, or
  remote identity.
- Without an authorized live transport, production launch rejects
  `adapterType: "xiaomi-home"` rather than silently routing through HA.
- Trace projection is bounded, deterministic, local-only, redacted by default,
  and derived solely from DSH session events.
- DSH remains the only agent runtime and only owner of turn/step execution.

## 2026-08-20 private-home migration checkpoint

A read-only inspection of the current private HA integration catalog found one
configured Xiaomi Home source with 10 devices. The same household also exposes
device cohorts through MQTT, Midea LAN, and Roborock. Only aggregate counts were
recorded; no device names, entity ids, state values, account data, URLs, or
credentials entered the repository.

This is useful migration evidence, not native Xiaomi product support. It shows
that the future Xiaomi bridge can be evaluated against real overlapping HA
coverage, including identity proposals and authority selection. It must not
bootstrap a native Xiaomi bridge from HA entity payloads or treat equal display
names as equivalence. The next production gate remains an authorized Xiaomi
transport plus an explicit user onboarding flow.
