# Architecture self-review

Date: 2026-08-19

## Scope conclusion

The DSH migration is complete at the runtime composition boundary: DSH owns the
Agent loop, session, prompt, tools, provider seam, and lifecycle. Hob-agent has
no direct `pi-ai` or `pi-agent-core` dependency. The official
`dsh-llm-pi-ai` package is the only provider adapter and carries its SDK as a
transitive implementation detail.

This repository now provides an executable Phase 0 composition root. It creates
one Cordis `Context`, mounts the neutral `HomeWorldService` before the Home
Agent, and owns bounded process shutdown. The service is runnable but not yet
production-complete: official DSH session persistence is composed, while
household prompt/Skill loading remains open.

The frozen neutral bridge read path is implemented through migration step 6:
one Zod-first v6.3 contract, catalog/registry/scoped credentials, epoch-aware
SQLite ingest, canonical identity and authority, world-model indexing, the HA
adapter, and the neutral agent snapshot. Actions and artifact hosting remain an
explicit M3 boundary rather than a second runtime hidden in Phase 0.

M3a now adds a review-only proposal path inside the same root: a private SQLite
proposal store, hub-owned evidence/conflict projection, DSH proposal tool, and
local Inbox facade. Approval remains a terminal review decision and cannot
apply an artifact or control a device.

## Verified boundaries

- The Home Agent exposes `get_home_snapshot` plus review-only
  `create_home_proposal`; neither tool has device or configuration authority.
- Proposal evidence, bridge watermarks, history gaps, and existing-rule
  conflicts are hub-produced. `foreignRules@1` catalogs are accepted only when
  their epoch matches the committed bridge watermark.
- Proposal creation is idempotent per producer/key. Review uses optimistic
  revisions, terminal decisions are immutable, and approval has
  `applicationStatus: not_available`.
- Optional Inbox HTTP is disabled without an explicit credential, binds only to
  `127.0.0.1`, stores only a derived verifier, authenticates every request, and
  requires exact same-origin bounded review POSTs.
- API-key profiles enter the official adapter through DSH `CredentialProvider`;
  the adapter resolves the selected SecretRef per operation.
- `CredentialProvider.describe()` now reports actual current availability, in
  accordance with the DSH contract, instead of treating a locator as a value.
- OAuth tokens are never downgraded to API keys. The provider-neutral OAuth seam
  preserves SecretVault storage, refresh serialization, expiry metadata, and
  redacted failures, and fails closed without a real DSH OAuth adapter.
- Provider probes use DSH `LlmRuntime`; profile ordering, cooldowns, failover,
  Keychain isolation, and error classification retain the stronger mechanisms
  adapted from OpenClaw without importing its runtime.
- Runtime ownership tests reject the removed Pi runtime, direct Pi SDK imports,
  and named legacy entry points.
- Bridge architecture guards reject ecosystem vocabulary in the agent layer,
  removed bridge contracts/services, and raw HA payloads in the canonical
  world model.
- Bridge IDs and remote installation IDs are independently bound; a changed
  remote identity fails closed until an explicit rebind.
- SQLite journals, registry data, world-model files, and WAL/SHM sidecars are
  private; production launch requires an explicit durable data directory.
- The stable Home Agent session is created or resumed through the official DSH
  SQLite provider. Raw conversation and tool events remain DSH-owned local
  data, while Inbox trace reconstruction stays bounded and metadata-only.
- State authority changes use a candidate resync and a new consistent watermark
  before one atomic coordinator commit. Snapshot reads cannot invoke the
  chooser as an implicit failover path.
- Hub world and capability IDs are deterministic opaque identifiers across
  restart and observation order. Device identity remains separate from the
  bridge-salted principal registry.

## Completed architecture gates

### P0 — executable composition root

`packages/hub` now owns one process entry that creates the root Cordis context,
provides an immutable allowlisted DSH launch environment, mounts the neutral
HomeWorld bridge runtime followed by `mountDshHomeAgent`, and disposes the
entire tree through the root fiber. Startup failure closes already-mounted
resources. SIGINT/SIGTERM cleanup is bounded to five seconds and a repeated
signal escalates to immediate exit.

The Phase 0 composition root belongs to `packages/hub`, which remains the
single service process. The hub may depend on a narrow agent-layer composition
export; the agent layer must not depend back on hub implementation modules and
continues to consume household data only through the neutral HomeWorld service
seam. This keeps process ownership in the monolith without creating a third
runtime or a second service.

## Open architecture gaps

### P2 — non-local Inbox delivery

Authenticated local delivery is implemented. LAN/remote exposure is not: it
would require TLS, device/user identity, stronger session management, and a
separate threat review. Do not make the bind host configurable as a shortcut.

### P1 — session retention and household reset

Restart-safe session history now uses the official DSH SQLite provider at the
production data path. The provider has no retention or deletion API. Define a
governed household reset/export policy upstream before offering either action;
do not mutate DSH tables directly.

### P1 — household Skills

An explicit household directory can now load bounded `SOUL.md`, `HOME.md`, and
`MEMORY.md` startup snapshots through the DSH prompt/context registry without
expanding tool authority. `HEARTBEAT.md`, hot reload, memory writes, and
filesystem Skills remain deferred. Skills should enter through DSH's provider
once its filesystem packages share the runtime compatibility family; do not
create a parallel registry.

### P2 — bounded probe lifecycle

`ProfileLiveProbeOptions.createRuntime` returns only an LLM boundary and has no
disposer contract. A future factory that creates a Cordis fiber must return an
owned disposable handle so probes cannot leak adapters, timers, or services.

### P2 — DSH invariant companions

The composition has not enabled the optional DSH invariant companions. Decide
which invariants run in production when the executable composition root is
introduced.

## Cleanup decisions

- Renamed the Home Agent composition API so the product surface no longer
  exposes the internal Pi-backed adapter name.
- Removed the duplicate profile credential mounting helper; the production
  composition and `DshProfileCredentialProvider` are the single path.
- Removed the unused process-local OAuth refresh coordinator; the active store
  serialization and cross-process refresh lock remain.
- Removed the unused `DshLlmRuntime` structural alias.
- Retained auth-profile, fallback, OAuth lifecycle, external-CLI, and diagnostic
  modules that are not yet wired to a process root: they are tested product
  governance foundations, not alternate runtimes. Their product availability
  remains explicitly marked incomplete.
