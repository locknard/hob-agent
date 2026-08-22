# Architecture self-review

Date: 2026-08-22
Scope: V4 household product runtime and DeepSeek Harness alignment

## Conclusion

The repository has one runtime. DeepSeek Harness owns the Agent loop, model
provider seam, session, prompt assembly, tool registry, cancellation, token
measurement and compaction transaction. Cordis composes the single TypeScript
service. `pi-agent-core` is absent, and `pi-ai` remains an internal dependency
of the official `dsh-llm-pi-ai` adapter.

The Hub owns every household authority boundary. Bridges publish versioned
neutral descriptions; the Agent sees governed tools; layouts receive a bounded
presentation projection. Adapter-native payloads, credentials, bridge clients,
Cordis context and executors remain outside the Agent and layout contracts.

The V4 migration has one authenticated Product Shell and one household command
path. The retired Inbox runtime and Control Center have been removed.

## Runtime ownership

- `packages/hub` owns bridge registration, state ingestion, SQLite persistence,
  world indexing, proposals, onboarding, advice, corrections, safety, one-shot
  actions, batch actions, scheduling and policy-enforced execution.
- `packages/agent-layer` mounts the DSH Agent and exposes only bounded household
  tools. A tool can request work from a Hub owner; it cannot acquire bridge or
  execution authority.
- `packages/inbox-web` renders the canonical product projection and carries
  authenticated commands to typed Hub ports. Host-owned safety, review counts,
  authentication and command dispatch stay outside replaceable layouts.
- `contracts` owns the Zod-first neutral bridge boundary. HA and Xiaomi are
  equal adapters behind this boundary.

## Action and safety closure

Every one-shot action is prepared from an exact `actions@1` descriptor. Before
dispatch, `HomeWorldService` reads the descriptor again and compares the target,
neutral action, schema and display metadata. A changed or stale description
produces `invalid_target` and no adapter call.

The action plane applies three policy classes:

1. `direct` for reversible actions initiated by an authenticated present member;
2. `confirmation` for broader reversible effects that require an explicit
   present-person confirmation;
3. `administrator` for locks, valves, security and other high-impact effects,
   approved on a private device bound to an adult administrator.

State verification requires a recent successful bridge contact. A stale bridge
turns both action verification and safety resolution into `unknown`. Startup
converts persisted `approved` or `executing` tickets into the durable
`interrupted_before_verification` state; it never repeats the action.

Batch commands preflight all exact descriptors before dispatch and preserve one
result per target. Verified, pending-confirmation, failed and unknown results
remain separate. No aggregate success can hide a partial outcome.

Safety incidents are Host-owned and persist independently from the selected
layout. Acknowledgement stops attention feedback. Fresh trusted sensor state
owns resolution.

## Review and proposal closure

Runtime confirmations and persistent proposals have separate stores, commands,
counts, expiry semantics and badges.

- Runtime confirmations display a TTL, fail closed on expiry, write expiry
  activity and accept one decision. Runtime rejection never creates a proposal
  latch.
- Persistent proposals use a five-slot capacity. `pending` and `snoozed` both
  occupy a slot. New evidence merges into the matching unresolved `dedupKey`.
  A full set returns `capacity_full` and retains no sixth candidate or overflow
  queue.
- “Only this time” closes the current proposal. “Do not suggest this again”
  records the durable deduplication latch and returns a visible acknowledgement.
- Direction approval, trial and enablement remain separate consent steps.

## Advice, correction and media closure

Advice turns persist accepted, progress, streaming, background, completed,
failed and cancelled states. SSE replay uses durable event cursors. Restart
recovery resumes the same background question, and completion notifications are
acknowledged only after a successful page response.

Corrections have three explicit destinations. Household facts update the marked
`MEMORY.md` section; preferences update the marked `SOUL.md` section; future
behavior creates a governed proposal. A durable single-flight reservation makes
concurrent idempotent submissions converge on one result. The product always
returns “已更新” with the destination or proposal identity.

Media conversation resolves exact players and opaque catalog references, asks
for missing queue intent, prepares a typed `play_media` action and enters the
same action-ticket owner used by every other device effect. Music Assistant is
a provider behind the neutral media catalog. Playback authority comes from the
Hub policy and fresh read-back, never from search results or model text.

## Onboarding closure

The eight onboarding checkpoints are durable and resumable. They cover household
and assistant naming, read-only bridge discovery, map confirmation, private
device binding, per-capability action authority, safety rehearsal, observation
consent and the first real question. Step 8 creates a durable advice turn before
the checkpoint completes and redirects to that exact conversation. Missing
household storage, bridge choices or advice ownership leaves the current step
explicitly blocked.

## Web product and layout boundary

The Product Shell serves `/home`, `/conversation`, `/review-center`, `/activity`,
`/control`, `/settings`, `/onboarding` and `/voice-preview`. Life and Control
views consume the same projection and submit the same intents. The
`ProductViewRegistry` selects registered providers, keeps a device-local
preference and recovers to `builtin.life`. Authentication, safety, review badges
and command dispatch remain fixed in the Host.

The Host distinguishes session switching from a persistent device default. The
settings command validates the registered provider and member/device permission
before writing the preference cookie. Both built-in providers continue to submit
the same governed review and control intents. The Host renders the only view
switcher, so a provider cannot create a competing navigation path.

The Control projection exhaustively maps every neutral connection state. Connected
and quiet homes expose governed actions; connecting, disconnected and unknown homes
show the last known value while actions wait for a classified live connection.
Control feedback also enforces valid combinations: verified may expose undo,
pending confirmation may expose an expiry, and failed or unknown remain informative.

Provider presentation preferences are closed declarations registered beside the
provider. The Host validates and persists a bounded choice map, renders the settings
surface and applies device permission. The values affect layout only and remain
outside the Hub intent, Agent and bridge boundaries. The registry freezes provider
metadata, and each render receives a deep-frozen copy so Host-owned safety and
governance state stays canonical.

Declarative layout recipes compile untrusted data into a deeply frozen Host slot
plan. The grammar contains only closed semantic routes, layout modes, widths and
route-scoped slot identifiers. Reviews and control remain atomic Host workspaces;
the recipe has no executable content, transport location, query or authority field.
The Host renders each declared slot through its canonical renderer in a bounded
six-column grid and supplies canonical pages for routes omitted by a recipe. The
fixed shell continues to own identity, safety, navigation, view recovery and the
two review lifecycles. Compact screens collapse slots to one column and contain
the growing view list inside a Host-owned selection panel above mobile navigation.

Recipe conformance runs as a deterministic, side-effect-free publication check.
Its immutable report binds the compiled ordered plan to a SHA-256 identity and
records compilation, plan freezing, deterministic rendering, semantic headings,
Host ownership, canonical fallback and responsive layout. Invalid data produces a
redacted status-only report. This seam stays independent from package loading,
signatures, grants and executable plugin lifecycle.

The HTTP composition accepts up to 16 explicit recipe values as a deployment seam.
It compiles and checks the exact immutable plan before the listener opens, then
registers a Host-rendered provider. A rejected value returns one stable redacted
startup classification. Runtime discovery, package import and manifest processing
remain governed by their later phase gates.

The Host renders two views as direct shortcuts and three or more through one native
disclosure. Desktop uses an anchored panel; compact screens use a bounded bottom
panel. Escape returns focus to the trigger, pointing elsewhere closes the panel and
long labels stay inside the viewport. View selection continues to preserve the
semantic route, selected proposal, action feedback, batch result and every Hub-owned
safety and review surface.

Layout authoring drafts belong to Hub persistence. The private SQLite record carries
an opaque id, owner principal, optimistic revision, bounded label, at most 64 KiB of
inert source and an update timestamp, with a 32-draft household ceiling. Source stays
inside the authenticated owner editing path. Updates and explicit deletion use the
expected revision; deletion releases capacity. Preview parses and compiles one exact
revision, runs recipe conformance and uses a Host-owned interaction-disabled render;
save and preview create no provider, grant, default change or device authority.

Layout publication is a separate Hub command over an exact owner-scoped draft
revision. The Hub recompiles and rechecks conformance, retains the immutable source
and digest as a bounded publication generation, and moves an active recipe pointer
only after registry ownership is available. Publication, rollback and deactivation
are administrator actions with the latest 256 actor-attributed audit events retained.
The administrator workspace presents the latest eight events as action, recipe id,
actor and time while keeping source, digest and generation identifiers inside the
Hub boundary. They change chooser availability only; current-session and
device-default selection remain separate Host commands. Static provider ids keep
their original owner and remain reserved from published drafts.

The checked developer recipe under `examples/views` enters the same source-size,
JSON compilation and seven-check conformance path used by publication. The local
`pnpm check:view` command prints only recipe id, exact digest and check count on
success, or one stable failure category. Submitted content and parser details remain
inside the local validator.

The local HTTP credential is a trusted deployment credential. Launch
configuration binds that credential to one explicit principal, presence state
and private/shared device class. A deployment that exposes the service beyond
loopback places it behind an identity-aware local gateway and supplies the
corresponding binding; the Phase 0 server itself stays loopback-only.

## Verification

- Architecture guards reject legacy Pi runtime ownership, adapter vocabulary in
  the Agent layer and raw ecosystem payloads beyond the bridge boundary.
- Domain and HTTP tests cover restart interruption, stale bridge state,
  impossible confirmation decisions, capacity limits, correction concurrency,
  onboarding replay, batch partial results and media confirmation.
- Browser verification covers all eight routes at 1440×900 and 390×844 with one
  `main` landmark, zero horizontal overflow and zero console warnings/errors. The
  layout publication workspace additionally covers exact actor-attributed history,
  hidden generation identifiers and complete wrapping at 390 px.
- Fresh release commands: `pnpm test` (1,227 passing tests), `pnpm check`,
  `git diff --check`, and a repository secret scan.

## Reviewed structural constraint

`proposal-inbox-http-service.ts` remains the single authenticated HTTP composition
owner. The layout-workspace presenter now lives in the internal
`product-layout-authoring.ts` module with the same typed port and Host registry
inputs, reducing the HTTP owner from 3,268 to 3,067 lines. Authentication, request
validation, command dispatch and registry mutation stay in the HTTP owner.

`product-view-recipe-draft-store.ts` keeps draft and publication invariants together
in 874 lines. Separate internal SQLite record codecs from command rules before
adding package metadata or signature state. This extraction preserves the current
public contracts and Hub authority owner.

## Current architectural direction

The next work broadens household coverage inside these boundaries: richer
neutral capability descriptions, additional bridge adapters, declarative layout
providers and real-home reliability evidence. It extends the single DSH/Cordis
runtime and the existing Hub owners.
