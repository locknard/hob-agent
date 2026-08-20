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

To review persisted proposals afterward without reconnecting HA or starting
DSH, keep only `HOB_DATA_DIR` and `HOB_INBOX_AUTH_TOKEN` set and run:

```sh
pnpm inbox:home
```

The command prints its authenticated `127.0.0.1` URL. It can record an approval
or rejection, but approval still cannot apply an automation or control a
device. It also shows the five most recent metadata-only observation attempts.
The Inbox includes an all-time count-only household calibration summary over
proposal decisions, structured feedback, observation outcomes, and bounded
Agent-reported no-proposal dispositions.
When the full runtime is connected, **Ask about your home** accepts one bounded
question and returns a locally persisted, structured advice document. The
Agent may suggest a reversible trial and optional sensing capabilities, but it
cannot change a rule or device. Stored answers remain readable in standalone
Inbox mode. See [`docs/household-advice.md`](docs/household-advice.md).
See [`docs/standalone-inbox.md`](docs/standalone-inbox.md) and
[`docs/observation-audit.md`](docs/observation-audit.md), plus
[`docs/household-calibration-summary.md`](docs/household-calibration-summary.md).
The recommended sequence for a real-home trial is documented in
[`docs/household-pilot.md`](docs/household-pilot.md).

For behavioral evidence, keep the full runtime connected and use **Observe
now** in its authenticated Inbox. This starts one paid turn through the same
readiness, pending-proposal, Agent-idle, and audit gates as periodic
observation, without enabling a recurring cadence. The standalone
`pnpm inbox:home` review process cannot start observations.

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
`foreignRules@1` conflict checks are attached before a proposal enters the
Inbox. Device actions, configuration writes, and proposal application remain
deliberately unavailable.

The Hub also contains the first non-applying neutral Artifact foundation:
strict immutable ECA revisions, stable canonical hashes, append-only lifecycle
and audit records, and separately versioned evidence, risk, and authority
assessments. New automation proposals include the same closed neutral ECA
content as a review-only candidate; the Hub validates its selected devices and
capability evidence, and the Inbox renders the exact trigger, conditions,
actions, rollback, and postconditions. Production mounts only bounded Artifact
read queries and metadata-only diagnostics. Unmounted Hub-only producer cores
can already convert the exact approved Proposal into one idempotent revision-one
draft, produce evidence from the approved source plus the HomeWorld query/snapshot
port, and produce authority assessments from a Hub-private fresh-world opaque
binding input plus the candidate registry. Notify-only artifacts explicitly
produce an empty authority scope. The private authority candidate registry core
and `ActionAuthorityConfiguration` (`configIdentity` + `configRevision`) are
tested in isolation; none of these mutation seams is wired to the production
composition. An unmounted `HomeWorldAuthorityBindingSource` creates fresh,
gap-free, binding-scoped opaque inputs without exposing native routes, and an
unmounted `ArtifactRiskProducer` applies the fixed Hub risk policy only after
exact evidence, authority, and conflict checks. An unmounted source-bound
conflict reader maps the approved Proposal's checked foreign-rule evidence and
bounded existing Artifact overlap into that closed conflict input. Its opaque
source identity changes when the checked rule input or any scanned Artifact row
changes, even when the resulting findings remain empty. An unmounted
Hub-private coordinator now exposes only exact approved-Proposal production and
exact Artifact assessment refresh commands; it returns a metadata-only receipt
only after evidence, authority, and risk rows agree. Fresh current-catalog
conflict refresh and any production invocation remain unavailable. Compilation,
simulation, approval tickets, and execution also remain unavailable; an
approved proposal is not an installed automation.

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

Inbox HTTP is absent unless `HOB_INBOX_AUTH_TOKEN` is explicitly configured.
When enabled it binds only to `127.0.0.1`, requires authentication on every
request, and enforces same-origin review and observation POSTs. The launch
config retains only a credential verifier, not the raw token.

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
