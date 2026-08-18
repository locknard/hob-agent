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
production-complete: session persistence and household prompt/Skill loading
remain open.

The frozen neutral bridge read path is implemented through migration step 6:
one Zod-first v6.3 contract, catalog/registry/scoped credentials, epoch-aware
SQLite ingest, canonical identity and authority, world-model indexing, the HA
adapter, and the neutral agent snapshot. Actions and artifact hosting remain an
explicit M3 boundary rather than a second runtime hidden in Phase 0.

## Verified boundaries

- The Home Agent exposes only the read-only `get_home_snapshot` tool.
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

### P1 — session persistence decision

The Home Agent mounts DSH's in-memory `SessionStore`; the declared
`dsh-session-persistence` package is not composed. Decide and document the
hub-owned persistence provider before treating session history as restart-safe.

### P1 — household prompt and Skills

The current prompt is fixed or caller-supplied. `home-template`, household
memory, and filesystem Skills are not loaded yet. They must enter through the
DSH prompt/Skill seams without expanding tool authority.

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
