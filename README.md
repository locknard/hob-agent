# hob-agent

An agent-first smart-home hub. Phase 0 connects to an existing Home Assistant
instance and turns observations into reviewable, reversible proposals.

## Workspace

- `packages/hub`: neutral bridge runtime, event ingestion, world model, and the
  built-in Home Assistant adapter.
- `packages/agent-layer`: agent prompts, governed tools, and audit boundaries.
- `packages/inbox-web`: proposal inbox web application.
- `contracts`: versioned bridge-contract types.
- `home-template`: editable home knowledge workspace template.

## Getting started

```sh
pnpm install
pnpm check
```

The repository is in Phase 0. The Cordis-hosted DSH Home Agent, Home Assistant
bridge, provider credential/profile foundations, governed snapshot/proposal
tools, durable proposal store, and local Inbox review facade have executable
tests. Proposal application and device control remain deliberately unavailable.

## Development workflow

`CLAUDE.md` is the canonical development guide. Root `AGENTS.md` is generated
from it for agent tooling and must not be edited directly. `pnpm install`
configures a tracked pre-commit hook that refreshes and stages `AGENTS.md`.

Before handing off a change, run:

```sh
pnpm test
pnpm check
```

See `CLAUDE.md` for the Phase 0 scope, architecture boundaries, security rules,
and test/commit discipline.

## Phase 0: local read-only bridge

The initial implementation connects to Home Assistant's WebSocket API, reads a
state and registry bootstrap snapshot, and subscribes to `state_changed`
events. Configure a neutral bridge catalog locally; never commit a token.
`HOB_BRIDGES` contains only bridge identity, adapter type, non-secret config, and
explicit credential locators. On macOS, prefer an exact bridge-scoped Keychain
locator:

```sh
export HOB_DATA_DIR="/var/lib/hob-agent"
export HOB_BRIDGES='[{"bridgeId":"ha-main","adapterType":"home-assistant","config":{"baseUrl":"http://homeassistant.local:8123","authenticationPrincipal":"home-owner"},"credentialRefs":{"access-token":"keychain:hob-agent/bridge:ha-main:access-token"}}]'
export HOB_BRIDGE_ID='ha-main'
export HOB_BRIDGE_CREDENTIAL_ALIAS='access-token'
# Enter the HA token without echo; only the locator above remains in config.
pnpm credentials:bridge
export HOB_MODEL=deepseek/deepseek-v4-flash
# Preferred on macOS: enter without echo; the key is stored in Keychain.
pnpm credentials:model
# Optional local review UI (HTTP Basic user is `home`):
export HOB_INBOX_AUTH_TOKEN='at-least-32-random-characters-kept-local'
export HOB_INBOX_PORT=8787
export HOB_INBOX_PRINCIPAL_ID='household-member'
export HOB_INBOX_PRINCIPAL_ROLE='adult_member'
export HOB_INBOX_DEVICE_KIND='private'
export HOB_INBOX_DEVICE_BOUND_PRINCIPAL_ID='household-member'
# Optional local observation cadence (disabled unless explicitly set):
export HOB_OBSERVATION_INTERVAL_MINUTES=360
export HOB_OBSERVE_ON_START=false
# Optional bounded SOUL.md, HOME.md, and MEMORY.md household context:
export HOB_HOME_DIR='/absolute/path/to/private-home'
# Legacy/development bridge fallback: use `env:HOB_HA_TOKEN` (or the old raw
# `HOB_HA_TOKEN` locator) and set that variable only in the launch environment.
# Legacy/development model fallback: set the matching DEEPSEEK_API_KEY,
# OPENAI_API_KEY, ANTHROPIC_API_KEY, MOONSHOT_API_KEY, or ZAI_API_KEY.
pnpm start
```

For a self-hosted OpenAI-compatible deployment, select the neutral custom
provider and configure its HTTPS endpoint; keep the token in the same Keychain
flow:

```sh
export HOB_MODEL='custom/deployment-model-id'
export HOB_MODEL_BASE_URL='https://models.example.com:8443/v1'
pnpm credentials:model
pnpm credentials:test
```

`HOB_MODEL_BASE_URL` is valid only for `custom`. One endpoint is active per
process; switching to a backup endpoint is currently explicit rather than
automatic.

`credentials:model` uses `HOB_DATA_DIR` and the provider selected by
`HOB_MODEL`. Re-running it safely rotates that provider's primary key. Only a
non-secret profile locator and selection order are written to the private
`auth-profiles.json` (`0600`); the key itself is sent through no-echo stdin to
macOS Keychain and is never placed in command arguments or repository files.
The selected Keychain profile takes precedence over ambient API-key variables.
An explicit paid connection check can then be run without starting a bridge or
persisting model content:

```sh
pnpm credentials:test
```

It sends the minimal DSH request and prints only model, classified status, and
latency metadata.

For the opt-in Music Assistant catalog credential, enter the token without
echo:

```sh
pnpm credentials:music-assistant
export HOB_MUSIC_ASSISTANT_BASE_URL='http://music-assistant.local:8095'
export HOB_MUSIC_ASSISTANT_CREDENTIAL_REF='keychain:hob-agent/media:music-assistant:access-token'
# Optional governed playback binding: neutral Hub capability → private MA player id
export HOB_MUSIC_ASSISTANT_PLAYER_BINDINGS='{"hwc-media-room":"ma-player-room"}'
```

The command writes only the fixed Keychain locator
`keychain:hob-agent/media:music-assistant:access-token` and prints locator
metadata. It never discovers or serializes `HOB_MUSIC_ASSISTANT_TOKEN`; an
explicit development `env:HOB_MUSIC_ASSISTANT_TOKEN` reference is the only
environment-backed alternative. Both launch settings are required; omitting
both leaves Music Assistant unloaded, while providing only one fails startup.
Catalog search and neutral intent preparation load with that pair. Adding the
explicit player binding enables governed `play_media` and `stop_media` through
the Hub one-shot action plane, including exact Music Assistant state readback
and the normal ten-second undo window. Provider player ids and media URIs remain
inside Hub configuration and the authenticated Music Assistant client.

Safety alerts use explicit neutral capability bindings. Configure each trusted
sensor with its active and clear values; Hub keeps the incident open through
disconnects and resolves it after a fresh clear value arrives:

```sh
export HOB_SAFETY_BINDINGS='[{"id":"kitchen-leak","hwCapabilityId":"hwc-kitchen-leak","kind":"water_leak","title":"厨房漏水","sourceLabel":"厨房漏水传感器","stateAttribute":"state","activeValues":["on"],"clearValues":["off"]}]'
```

Before enabling the Agent or observation schedule, the same bridge and data
configuration can be validated without `HOB_MODEL` or a model API key:

```sh
pnpm validate:home
```

The command mounts only HomeWorld and prints aggregate readiness and counts; it
never prints household names, IDs, state values, URLs, credentials, or raw
errors. Its counts include devices with and without an accepted neutral space
binding so an incomplete household map stays visible, plus aggregate
available/unavailable existing-rule coverage before a model call. See
[`docs/home-validation.md`](docs/home-validation.md).
It also separates explicitly non-spatial service objects from genuine
space-review gaps through the neutral, epoch-bound `orgHints@1` extension, and
reports pending identity-governance work only as aggregate counts. Aggregate
logical journal capacity makes the fail-closed ingest quota visible before an
unattended pilot; it does not silently prune evidence.

To preview canonical-journal retention without connecting a bridge, loading a
model, deleting evidence, or writing a retention audit, reuse `HOB_DATA_DIR`
and `HOB_BRIDGES` and select one configured bridge:

```sh
export HOB_RETENTION_BRIDGE_ID='ha-main'
export HOB_RETENTION_REASON='manual aggregate preview before a longer pilot'
pnpm retain:home
```

The command prints aggregate candidate/protection counts only. Apply is not
available from this facade: `--apply` and confirmation variables fail closed
until incomplete-epoch and cross-database proposal-pin safety is fully proven.

After validation, one explicit paid/model-backed observation can be run without
enabling the recurring scheduler or Inbox HTTP listener:

```sh
pnpm observe:home
```

It uses the same Hub gates, creates at most one review-only proposal, prints
only a metadata outcome (including an optional bounded Agent-reported reason
when it creates no proposal), records a metadata-only observation attempt under
`HOB_DATA_DIR`, and then exits. See
[`docs/one-shot-observation.md`](docs/one-shot-observation.md) and
[`docs/observation-disposition.md`](docs/observation-disposition.md).

The single full runtime serves the authenticated local product after
`HOB_INBOX_AUTH_TOKEN` and the four explicit Inbox identity values shown above
are configured. It can record an approval or rejection, while persistent
automation changes continue through proposal, preparation and second consent.
It also shows recent metadata-only observation attempts and the household
calibration summary over decisions and outcomes. **Ask about your home** accepts one bounded
question and returns a locally persisted, structured advice document. The
Agent may suggest a reversible trial and optional sensing capabilities.
Persistent behavior follows proposal, evidence, trial and approval; device
actions follow the Hub action gate. Stored answers remain readable after a
restart. See [`docs/household-advice.md`](docs/household-advice.md),
[`docs/observation-audit.md`](docs/observation-audit.md), and
[`docs/household-calibration-summary.md`](docs/household-calibration-summary.md).
The recommended sequence for a real-home trial is documented in
[`docs/household-pilot.md`](docs/household-pilot.md).

The product includes an accessible voice-first household surface and governed
media playback. Voice remains an input mode for the single DSH runtime. Media
discovery is read-only; playback passes through Hub policy, action tickets,
confirmation when required, verification and audit. See
[`docs/voice-and-media-interaction.md`](docs/voice-and-media-interaction.md).
When the local product is enabled, `/voice-preview` exposes the authenticated
push-to-talk surface. A direct member gesture opens Web Speech, live and final
captions remain visible, three bounded recognition failures lead to text input,
and the final transcript enters the canonical `/conversation` route.

The Hub owns the `mediaCatalog@1` boundary. A trusted Music Assistant-compatible
provider returns bounded neutral media kinds, while Agent-facing candidates use
opaque, tenant- and generation-bound short-lived references. Provider ids,
URLs, account data, tokens and raw payloads remain inside the provider boundary.
When a neutral catalog service is explicitly mounted, the DSH Agent gains the
bounded read-only `search_home_media` tool. Deployments without a catalog keep
the tool absent. Its model-facing projection removes expiry and all
provider-native fields; `mediaRef` and `playable` remain discovery hints, not
playback authority.
When the same runtime also has a fresh neutral player inventory, it exposes
the media conversation tool. It re-resolves the opaque media reference and the
selected Hub player, asks for a missing queue choice, prepares the exact neutral
`play_media` action and requests the same governed action ticket used for other
household effects. Direct playback completes only after fresh policy and
read-back verification; confirmation and administrator classes route to their
respective owners.
The production Hub also mounts an authority-selected, neutral media-player
inventory and exposes it through the read-only `get_home_media_players` DSH
tool. The HA adapter uses a strict additive `ha.media-player@1` read schema;
reported volume is evidence, and same-label endpoints remain distinct. A
deterministic synthetic catalog is available only to component/runtime tests.
The Hub also contains a transport-injected, read-only Music Assistant search
provider. It maps the reviewed grouped `music/search` subset into neutral
catalog rows, enforces one total result budget, propagates cancellation, and
keeps MA URIs and provider metadata behind `mediaCatalog@1`. It creates no
network connection and is not a production default. Catalog search is
best-effort; an empty result is not proof that no matching media exists.
The `search_home_media` result carries machine-readable `complete` or
`best_effort` coverage so the model does not have to infer completeness from
empty candidates.

For behavioral evidence, keep the runtime connected and use **Observe now** in
the authenticated product. This starts one paid turn through the same
readiness, pending-proposal, Agent-idle, and audit gates as periodic
observation, without enabling a recurring cadence.

To create a private review draft of the neutral room/device map without calling
a model or replacing `HOME.md`, set an explicit private `HOB_HOME_DIR` and run:

```sh
pnpm draft:home-map
```

This exclusively creates mode-`0600` `HOME.import.md`; review and deliberately
merge accepted facts into `HOME.md`. See
[`docs/home-map-draft.md`](docs/home-map-draft.md).

DeepSeek Harness (DSH) is the project's only Agent Runtime. It owns the agent
loop, session, prompt assembly, tool registry, cancellation lifecycle, token
metering, and compaction transaction. The
Home Product Bundle contributes compact paginated `get_home_inventory`
discovery, metadata-only post-baseline `get_home_activity` candidate triage,
bounded structured `get_home_calibration` review history,
the bounded paginated read-only `get_home_snapshot` tool, the
bounded read-only `get_home_evidence` tool, plus the review-only
`get_home_rules` catalog inspection tool and `create_home_proposal` tool. Hub-owned evidence and
`foreignRules@2` conflict checks are attached before a proposal enters the
Inbox. A catalog is usable only when its exact `epochId + lastSeq` matches the
bridge's committed watermark. Device actions use the Hub's exact descriptor,
policy, action-ticket, verification and audit owners. Persistent behavior uses
proposal, preparation, trial and explicit enablement.

The Hub also contains the first non-applying neutral Artifact foundation:
strict immutable ECA revisions, stable canonical hashes, append-only lifecycle
and audit records, and separately versioned evidence, risk, and authority
assessments. New automation proposals include the same closed neutral ECA
content as a review-only candidate; the Hub validates its selected devices and
capability evidence, and the Inbox renders the exact trigger, conditions,
actions, rollback, and postconditions. A qualifying approval atomically queues
a durable Hub-private preparation job. The production root wakes that job only
for an approval committed while the process is running, then executes the fixed
Artifact → evidence → authority → risk → compile → dry-run chain. Writable
registries, the runner, and bridge authority inputs remain private to the root;
Cordis, the Agent, Inbox, plugins, and bridges can discover only bounded review
projections. Notify-only artifacts explicitly produce an empty authority scope.
Startup never scans or replays queued/running jobs, and preparation has no
device-write, credential, executor, or remote-rule installation port. Approval
tickets and execution remain unavailable; an approved or compiled proposal is
not an installed automation.

Long-running sessions use the official DSH compaction engine with its one
supported summarizer hook replaced by a household checkpoint template; the
project does not implement a second compaction runtime. See
[`docs/dsh-home-compaction.md`](docs/dsh-home-compaction.md).

The v6.4 read path also carries an optional closed `semanticKind` per
capability so the Agent can group lights, switches, sensors, and other reviewed
families without importing HA or MIoT vocabulary. The hint preserves its source
schema/binding and grants no equivalence or action authority.

The additive v6.5 topology path preserves per-binding room provenance through
opaque Hub space IDs and a neutral space catalog. HA and authorized Xiaomi
transports use the same shape; equal room names across bridges are never
silently merged. See [`docs/space-topology.md`](docs/space-topology.md).

`get_home_snapshot` defaults to 10 devices and never returns more than 20. It
supports exact hub-device selection plus neutral space and semantic-kind
filters, with an exclusive opaque cursor for deterministic continuation.
Model-facing pages correlate states through Hub capability IDs and do not
return adapter-native device, property, space, or schema identifiers. See
[`docs/bounded-home-query.md`](docs/bounded-home-query.md).

`get_home_inventory` returns at most 50 compact device summaries without
current values, capability identities, schemas, or adapter-native identities.
An observation exhausts this cheaper cursor before selecting a small candidate
set for detailed snapshot reads. See
[`docs/bounded-home-inventory.md`](docs/bounded-home-inventory.md).

`get_home_activity` returns at most 50 post-baseline device activity summaries
containing only opaque Hub IDs, aggregate event counts, latest receive times,
and neutral semantic kinds. It reduces name/order-biased candidate selection
but cannot support a behavioral claim without detailed evidence. See
[`docs/bounded-home-activity.md`](docs/bounded-home-activity.md).

`get_home_evidence` accepts only current hub capability IDs and returns at most
200 locally observed post-baseline state changes from the last seven days.
Bootstrap state is excluded, and incomplete bridge coverage or truncation is
reported explicitly. See [`docs/temporal-evidence.md`](docs/temporal-evidence.md).

When a proposal relies on those observations, the Agent selects only current
hub capability IDs and a bounded lookback. The Hub re-runs the query and stores
exact epoch/sequence references plus coverage in the local proposal; the model
cannot author journal provenance. See
[`docs/proposal-evidence-binding.md`](docs/proposal-evidence-binding.md).

Before proposing a new automation, an autonomous observation must exhaust the
bounded metadata pages for existing rules through `get_home_rules`. A stable
catalog version and strict cursor sequence make this a runtime gate rather than
prompt-only guidance. Missing or inconsistent catalogs stay
explicitly unavailable rather than looking empty; native rule IDs, YAML,
triggers, actions, and templates are not exposed. See
[`docs/home-rule-inspection.md`](docs/home-rule-inspection.md) and
[`docs/existing-rule-coverage-gate.md`](docs/existing-rule-coverage-gate.md).

Periodic observation is opt-in, local, and Hub-scheduled. It runs only after a
consistent bridge snapshot, skips a busy Agent, and stops generating new work
while any proposal is pending household review. The interval is limited to one
hour through seven days. See
[`docs/observation-scheduling.md`](docs/observation-scheduling.md).

Inbox HTTP starts when its token and explicit principal identity are configured.
It binds to `127.0.0.1`, authenticates every request, and enforces same-origin
review and observation POSTs. A private device also declares a principal
binding that exactly matches `HOB_INBOX_PRINCIPAL_ID`; a shared device omits the
binding and receives shared-device permissions. The launch config retains a
credential verifier while the secret stays in its configured secret source.

When `HOB_HOME_DIR` is set, the three household Markdown files are loaded as a
bounded startup snapshot through DSH's prompt/context registry. They personalize
the Agent but cannot add tools or bypass Hub policy. See
[`docs/household-prompt-context.md`](docs/household-prompt-context.md).

`pi-agent-core` is not part of the architecture. `pi-ai` exists only as a
transitive implementation detail of the official DSH LLM adapter; hob-agent
does not declare or import it, and it owns no product API or runtime lifecycle.

The intended user journey is documented in
[`docs/ha-onboarding.md`](docs/ha-onboarding.md).

The HA onboarding path starts with a credential-free WebSocket preflight. A
later private read-only checkpoint covered 75 neutral devices and 18,206
canonical events without recording household identities or values in this
repository. A current-process bootstrap still requires an explicitly supplied
token and the Phase 0 adapter remains read-only.

Supported model providers and credential boundaries are documented in
[`docs/model-providers.md`](docs/model-providers.md).

The OpenClaw-derived provider adaptation audit is tracked in
[`docs/openclaw-provider-adaptation.md`](docs/openclaw-provider-adaptation.md).

The repository now has one executable Cordis composition root for the neutral
HomeWorld bridge runtime and DSH agent. The production Home Agent creates or
resumes its stable session through the official DSH SQLite provider and loads
bounded household prompt context. An optional tenant Skill provider contributes
strict, contained, byte-bounded `SKILL.md` files through the official DSH
registry without granting tools or authority. See
[`docs/architecture-self-review.md`](docs/architecture-self-review.md) for the
verified boundaries and prioritized gaps.
The intended provider authorization and model-selection journey is documented
in [`docs/provider-onboarding.md`](docs/provider-onboarding.md).

DeepSeek `deepseek-v4-flash` has passed one explicit, one-token live probe through
the provider adapter. This validates the API-key transport path, not the still-
pending settings UI or Claude OAuth product flow. Never commit provider keys;
use a scoped environment reference or macOS Keychain profile and rotate any key
that has appeared in chat or logs.
