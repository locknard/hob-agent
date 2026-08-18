# Architecture self-review

Date: 2026-08-18

## Scope conclusion

The DSH migration is complete at the runtime composition boundary: DSH owns the
Agent loop, session, prompt, tools, provider seam, and lifecycle. Hob-agent has
no direct `pi-ai` or `pi-agent-core` dependency. The official
`dsh-llm-pi-ai` package is the only provider adapter and carries its SDK as a
transitive implementation detail.

This repository is not yet a deployable Phase 0 service. It currently provides
tested hub and Agent compositions, but no executable bootstrap creates a root
Cordis `Context`, mounts `HomeAssistantService`, mounts the Home Agent, and owns
process shutdown. Documentation and release claims must retain that distinction.

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

## Open architecture gaps

### P0 — executable composition root

Add one process entry that owns root Cordis startup/shutdown and mounts the HA
bridge followed by `mountDshHomeAgent`. Until that exists, the repository is a
composition library with integration tests, not a runnable hub.

### P1 — live HA world state and connection health

`HomeAssistantService.snapshot` is currently the bootstrap snapshot.
`state_changed` events are forwarded only to an optional callback and do not
update it; disconnects do not mark bridge health down. The bridge also needs to
reject the initial connection if the socket closes before authentication.
Implement these together with the hub-owned world-model index rather than
creating state inside the Agent layer.

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
