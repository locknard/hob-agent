# Architecture self-review

Date: 2026-08-20

## Scope conclusion

The DSH migration is complete at the runtime composition boundary: DSH owns the
Agent loop, session, prompt, tools, provider seam, token measurement,
compaction transaction, and lifecycle. Hob-agent has
no direct `pi-ai` or `pi-agent-core` dependency. The official
`dsh-llm-pi-ai` package is the only provider adapter and carries its SDK as a
transitive implementation detail.

This repository now provides an executable Phase 0 composition root. It creates
one Cordis `Context`, mounts the neutral `HomeWorldService` before the Home
Agent, and owns bounded process shutdown. Official DSH session persistence,
bounded household prompt context, the DSH Skill registry/loader, and one
reviewed first-party household-observation Skill are composed. When an explicit
household directory is configured, a tenant provider contributes a strict
bounded subset of `SKILL.md` through that same registry. It rechecks canonical
containment, rejects symlinks, caps file/catalog bytes and entries, rereads on
demand, exposes no resource path, and ranks below reviewed product Skills.
Tenant instructions remain untrusted model input and grant no tool or policy
authority.

Long-running observation sessions now mount the official DSH token meter,
basic compaction engine, and replay-safe tool-result pruner. The Home Product
Bundle overrides only the basic engine's supported summarizer hook so a coding
checkpoint is not used as household memory. Metadata-only compaction/prune
events reach the Inbox trace; summaries, raw outputs, provider errors, and
internal compaction ids do not.

The official DSH invariant registry is enabled before the first Agent is
created. Its executable session, Agent, scope, loop, LLM, tool, system-prompt,
and compaction companions check their package-owned event relationships at
runtime; rc.7 companions that explicitly declare no runtime invariant remain
unit/load-test concerns rather than decorative registrations.

The neutral bridge read path is implemented through migration step 6: one
Zod-first v6.3 base contract plus the additive v6.4 read-only capability
semantic kind and v6.5 neutral space topology, catalog/registry/scoped credentials, epoch-aware
SQLite ingest, canonical identity and authority, world-model indexing, the HA
adapter, and the neutral agent snapshot. Actions and artifact hosting remain an
explicit M3 boundary rather than a second runtime hidden in Phase 0.

Bridge credentials may now use exact bridge/alias-scoped macOS Keychain
locators. Launch projection does not enumerate or passively read Keychain;
resolution happens only for the configured bridge and declared alias when the
adapter connects. Secret-like fields, including nested API/access keys, are
rejected from ordinary bridge configuration.

The authenticated local Control Center now leads with household review work
and plain-language service health. Pending proposals do not masquerade as a
system fault, degraded consistency cannot appear ready, non-spatial service
objects do not create false room-review work, and provider/adapter/sequence
identifiers remain behind native progressive disclosure. It is still a
read-only projection and provides no configuration or execution control.

The Control Center also exposes the Hub-owned retention status as a
metadata-only details section: aggregate/per-bridge capacity, complete versus
partial/degraded coverage, coverage floor, and latest retention audit time,
result, and bytes deleted. It does not read journal records, proposal text, or
device values and never shows the internal retention policy id. An untouched
bridge honestly says **Not run yet** without making a healthy complete view
look degraded; partial/degraded coverage and exhausted capacity remain
attention states, with a fixed 90% used/max early warning and invalid quota
metadata failing closed. There is no retention button, HTTP mutation, Agent
tool, or timer.

M3a now adds a review-only proposal path inside the same root: a private SQLite
proposal store, hub-owned evidence/conflict projection, DSH proposal tool, and
local Inbox facade. Approval remains a terminal review decision and cannot
apply an artifact or control a device.

## Verified boundaries

- The Home Agent exposes bounded structured `get_home_calibration` review
  history, compact paginated `get_home_inventory`, metadata-only post-baseline
  `get_home_activity` candidate triage, bounded paginated
  `get_home_snapshot`, bounded read-only `get_home_evidence`, and
  review-only `create_home_proposal`; none has device or configuration
  authority. Inventory discovery omits current values, capability identities,
  schemas, and native identities. During autonomous observations, a runtime
  gate rejects proposal creation until a stable ordered inventory cursor is
  exhausted.
- Temporal evidence reads only selected current hub capability IDs and
  post-`sync-complete` state changes in the current epoch. Bootstrap rows are
  excluded, raw attributes/native identifiers stay in the Hub, and partial
  coverage is explicit.
- Temporal proposal claims are rebound by the Hub from selected current
  capability IDs; exact epoch/sequence references and coverage reach the Inbox,
  while the model cannot author journal provenance.
- Every new DSH Home Agent proposal includes a bounded expected household
  value, timing rationale, and one to six explicit uncertainties. The Inbox
  labels these as model-authored rationale, while Hub evidence, overlap, and
  risk remain separate authoritative sections. Existing v1 rows without the
  additive rationale remain readable.
- The Hub binds mutually exclusive selected-device space coverage into each
  new Home Agent draft. This exposes incomplete or ambiguous mapping in the
  Inbox without names or identifiers and without trusting the model to report
  its own context gap; legacy v1 proposals remain readable.
- Proposal evidence, bridge watermarks, history gaps, and existing-rule
  conflicts are hub-produced. `foreignRules@1` catalogs are accepted only when
  their epoch matches the committed bridge watermark.
- Proposal creation is idempotent per producer/key. Review uses optimistic
  revisions, terminal decisions are immutable, and approval has
  `applicationStatus: not_available`. New approve/reject decisions persist a
  bounded quality-feedback code in both review state and append-only audit;
  legacy v1 reviews remain readable and feedback cannot mutate household
  knowledge automatically. The Inbox projects only all-time counts of these
  codes and observation outcomes for calibration; it does not reinterpret
  proposal content or notes.
- The Agent calibration tool adds at most 20 recent reviewed proposal titles
  and structured decisions to those counts. It strips reviewer identity and
  notes, treats historical titles as untrusted, and cannot write memory or
  relax current evidence, conflict, policy, or approval gates. Autonomous
  proposal creation requires one successful fixed-window calibration read, so
  feedback awareness is not left to prompt compliance.
- Autonomous observation is disabled by default. The Hub owns its bounded
  cadence, requires a ready world and idle DSH Agent, and permits only one
  pending household proposal at a time. Each scheduled, manual, startup, or
  one-shot attempt also enters a separate metadata-only Hub audit ledger before
  the model can run; unfinished rows become interrupted on restart.
- The long-running full runtime also exposes an authenticated, same-origin
  **Observe now** action. It invokes the same Hub controller, readiness gates,
  DSH Agent turn, proposal boundary, and audit ledger as scheduled observation;
  the standalone review composition cannot invoke it. This adds no second loop.
- Completed audit attempts may retain only turn duration, token counters, and
  tool success/failure counts from the exact observation turn. This makes
  no-proposal cost visible without persisting prompts, tool payloads, provider
  identity, household state, or inferred monetary pricing.
- One-root acceptance coverage now exercises the canonical DSH tool loop from
  observation through trusted Hub evidence binding into the Inbox. The Home
  Agent retains its trace service explicitly so cross-plugin Inbox reads do not
  bypass Cordis injection ownership. Proposal detail slices the cumulative DSH
  session projection to the exact turn containing its stored root tool-call ID,
  so historical turns and their token cost are not attributed to the proposal.
- `pnpm validate:home` provides a model-free, aggregate-only readiness cut over
  the production HomeWorld paths before autonomous observation is enabled. It
  emits no household identities, values, URLs, credentials, or raw errors.
- Readiness also requires bridge traffic in the current process. A restored
  consistent cut remains readable but cannot make validation, mapping, or
  observation race ahead of the new adapter bootstrap and its epoch-bound
  extension catalogs.
- The DSH Agent can inspect the existing neutral `foreignRules@1` catalog
  through bounded `get_home_rules` pages before proposing an automation. An
  autonomous runtime gate requires a complete stable cursor sequence rather
  than trusting prompt compliance. The Hub still owns the authoritative
  proposal-time conflict check, and no rule body or mutation path crosses the
  tool boundary.
- Authoritative conflict coverage is scoped to every bridge binding of the
  selected devices. An unrelated bridge without a rule catalog cannot block a
  proposal, while a selected or merged cross-bridge device still fails closed
  unless every relevant catalog is available.
- The paginated DSH snapshot boundary strips adapter-native device,
  capability-instance, space, and schema identifiers. Model-visible states are
  correlated only by opaque Hub capability ID and neutral bridge ID; the full
  native binding projection remains Hub-internal for indexing and evidence.
- `pnpm observe:home` provides an explicit one-shot real-household acceptance
  path. It shares the scheduler's Hub-owned readiness, pending-proposal, and
  Agent-idle gates but mounts neither recurring scheduling nor Inbox HTTP.
- `pnpm draft:home-map` turns a ready neutral snapshot into a bounded private
  `HOME.import.md` review artifact without calling a model or overwriting
  household knowledge. It reports single-space, unassigned, and multiple-space
  coverage separately; ambiguous devices appear once as explicit confirmation
  tasks rather than being duplicated across apparently settled rooms. Native
  identifiers and current values remain absent.
- Aggregate validation exposes the count of pending identity-governance work,
  while the private map draft renders deduplicated possible-device links using
  only display names, opaque Hub IDs, and closed source provenance. It omits
  claims and evidence, and remains record-only: no draft edit approves or
  applies an identity merge.
- Private map review order is human-oriented by display name with Hub identity
  only as a stable tie-breaker. Names remain untrusted presentation data and
  cannot influence identity, placement, or authority.
- The neutral `orgHints@1` stream extension can mark a device explicitly
  non-spatial from structured adapter evidence. The Hub accepts it only in the
  committed replay epoch; names never drive this classification, and merged
  devices fail back to unknown unless every source agrees. This keeps service
  objects out of room-review work without making HA vocabulary part of core.
  Inventory and snapshot tools expose only the resulting `non_spatial` value,
  with prompt guidance that it proves neither physical type nor action safety.
- `pnpm inbox:home` mounts only the durable proposal store, metadata-only
  observation audit, and authenticated localhost review surface. It requires
  no bridge or model configuration and retains the same terminal, non-applying
  approval semantics.
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
- Runtime invariant companions fail structural DSH protocol violations under
  the owning upstream package instead of adding a product-side shadow checker.
- Bridge architecture guards reject ecosystem vocabulary in the agent layer,
  removed bridge contracts/services, and raw HA payloads in the canonical
  world model.
- Optional per-instance semantic kinds let HA and an authorized Xiaomi
  transport classify observations with one closed vocabulary while preserving
  source schemas and bindings. They grant no equivalence, binding, or action
  authority; unknown capabilities remain unclassified.
- Capability bindings may carry a Hub-owned opaque space identity, and the
  snapshot exposes a neutral space catalog. HA entity-area overrides and
  device-area inheritance are supported; authorized Xiaomi transports may
  supply room metadata. Equal names across bridges never auto-merge.
- Aggregate validation and Agent topology now use mutually exclusive
  single-space, unassigned, and multiple-space device counts. Unknown space
  references are unassigned and cross-binding ambiguity cannot inflate the
  apparent household-map coverage.
- Compact inventory pagination now treats the requested count as an upper bound
  and adapts each result below the DSH pruning threshold. The coverage cursor
  advances only through fully model-visible devices; an oversized single
  device fails closed instead of creating false whole-home coverage.
- Bridge IDs and remote installation IDs are independently bound; a changed
  remote identity fails closed until an explicit rebind.
- SQLite journals, registry data, world-model files, proposals, observation
  audits, DSH sessions, and WAL/SHM sidecars are private; production launch
  requires an explicit durable data directory.
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

The immediate next step is the bounded real-household pilot described in
[`household-pilot.md`](household-pilot.md), not another Agent Runtime layer.
The pilot's review outcomes and observed run metrics should decide which gap
below becomes product work next.

### Implemented foundation — non-applying Artifact Registry

The Hub now has a strict neutral ECA Artifact revision contract, canonical
content hashing, immutable SQLite revisions, append-only lifecycle/audit rows,
and separately versioned evidence, risk, and authority assessments. Dynamic
watermarks, policy decisions, and authority candidates never mutate the stable
Artifact bytes. Reads re-validate persisted rows and exact artifact references;
resource limits, idempotency, restart recovery, transaction rollback, corrupt
records, and private SQLite sidecars fail closed.

The production Cordis composition mounts only a read service. It exposes
bounded revision, audit, and assessment queries plus metadata-only diagnostics.
It deliberately exposes no create, assessment-recording, compile, simulation,
approval, bridge, credential, or execution method. The Control Center reports
that the Registry is available while explicitly reporting compilation,
simulation, and execution as unavailable.

This does not complete M3b. The next boundary must be a Hub-owned producer that
accepts an exact reviewed Proposal revision, independently validates its status
and evidence provenance, creates the closed Artifact shape, and registers its
durable retention references. M3c compiler and historical dry-run remain later,
pure-read work; device writes remain unavailable.

### Implemented foundation — canonical ingest-journal retention

The neutral ingest journal has a deterministic logical hard quota and fails
closed through bridge pause/quarantine, and now exposes one explicit per-bridge
retention operation. Real-household validation reports aggregate used, maximum,
and remaining logical bytes so exhaustion is visible before an unattended pilot.
A first live HA run reached 48% of the former 16 MiB default in roughly half an
hour while retaining no rejections or history gaps. That measured rate could
not support the product's bounded 168-hour evidence window. The default is now
256 MiB per bridge: enough headroom for the observed seven-day rate after the
semantic de-noising below, while remaining a finite fail-closed quota.

In the run's first 14 post-baseline minutes, 42% of comparable HA state events
repeated the preceding neutral attributes.
The HA adapter now suppresses those consecutive semantic duplicates before it
allocates a canonical envelope, reducing both journal growth and false Agent
activity without discarding a neutral state change. A fresh 10-minute run on
the updated path retained 291 post-baseline state events with zero consecutive
semantic duplicates, zero rejections, and zero history gaps; the aggregate
capacity report showed roughly 3% of the new quota in use.

`applyRetention` preserves the current manifest-verified recovery cut, the
minimum 168-hour temporal evidence window, open history gaps, and explicitly
supplied durable proposal references. The complete decision snapshot,
deletions, byte ledger, immutable audit, and coverage floor are protected by
one `BEGIN IMMEDIATE` transaction; a concurrent second SQLite connection cannot
insert a gap between selection and deletion. Partial coverage remains explicit.

The Hub-owned retention service now collects verified proposal references and
invokes the explicit operation without a scheduler; the Control Center exposes
its metadata-only capacity/coverage/audit status. A separate bounded physical
SQLite reclamation step remains future work. Rejection, gap, and heartbeat
metadata remain conservatively retained because their current schema has no
receipt timestamp.

### P2 — non-local Inbox delivery

Authenticated local delivery is implemented. LAN/remote exposure is not: it
would require TLS, device/user identity, stronger session management, and a
separate threat review. Do not make the bind host configurable as a shortcut.

### P1 — session retention and household reset

Restart-safe session history now uses the official DSH SQLite provider at the
production data path. The provider has no retention or deletion API. Define a
governed household reset/export policy upstream before offering either action;
do not mutate DSH tables directly.

### Implemented foundation — household Skills

An explicit household directory can now load bounded `SOUL.md`, `HOME.md`, and
`MEMORY.md` startup snapshots through the DSH prompt/context registry without
expanding tool authority. The tenant `SKILL.md` provider is also implemented
through the official DSH `SkillProvider` seam, with the containment and resource
limits described above; the general-purpose upstream filesystem provider is
not mounted over household content. Remaining product work includes an
installation/review UI, change provenance, explicit enable/disable state, and
eventual process isolation for third-party executable plugins. `HEARTBEAT.md`,
hot reload, and memory writes remain deferred. Do not create a parallel
registry.

### P2 — bounded probe lifecycle

`ProfileLiveProbeOptions.createRuntime` returns only an LLM boundary and has no
disposer contract. A future factory that creates a Cordis fiber must return an
owned disposable handle so probes cannot leak adapters, timers, or services.

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
