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
explicit credential environment-name references:

```sh
export HOB_DATA_DIR="/var/lib/hob-agent"
export HOB_BRIDGES='[{"bridgeId":"ha-main","adapterType":"home-assistant","config":{"baseUrl":"http://homeassistant.local:8123","authenticationPrincipal":"home-owner"},"credentialRefs":{"access-token":"HOB_HA_TOKEN"}}]'
export HOB_HA_TOKEN='long-lived-access-token'
export HOB_MODEL=deepseek/deepseek-v4-flash
export DEEPSEEK_API_KEY='...'
# Optional local review UI (HTTP Basic user is `home`):
export HOB_INBOX_AUTH_TOKEN='at-least-32-random-characters-kept-local'
export HOB_INBOX_PORT=8787
# Optional bounded SOUL.md, HOME.md, and MEMORY.md household context:
export HOB_HOME_DIR='/absolute/path/to/private-home'
# or select the matching OPENAI_API_KEY / ANTHROPIC_API_KEY / MOONSHOT_API_KEY / ZAI_API_KEY
pnpm start
```

DeepSeek Harness (DSH) is the project's only Agent Runtime. It owns the agent
loop, session, prompt assembly, tool registry, and cancellation lifecycle. The
Home Product Bundle contributes the read-only `get_home_snapshot` tool and the
bounded read-only `get_home_evidence` tool plus the review-only
`create_home_proposal` tool. Hub-owned evidence and
`foreignRules@1` conflict checks are attached before a proposal enters the
Inbox. Device actions, configuration writes, and proposal application remain
deliberately unavailable.

The v6.4 read path also carries an optional closed `semanticKind` per
capability so the Agent can group lights, switches, sensors, and other reviewed
families without importing HA or MIoT vocabulary. The hint preserves its source
schema/binding and grants no equivalence or action authority.

`get_home_evidence` accepts only current hub capability IDs and returns at most
200 locally observed post-baseline state changes from the last seven days.
Bootstrap state is excluded, and incomplete bridge coverage or truncation is
reported explicitly. See [`docs/temporal-evidence.md`](docs/temporal-evidence.md).

Inbox HTTP is absent unless `HOB_INBOX_AUTH_TOKEN` is explicitly configured.
When enabled it binds only to `127.0.0.1`, requires authentication on every
request, and enforces same-origin review POSTs. The launch config retains only a
credential verifier, not the raw token.

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
2026-08-18 LAN check reached Home Assistant `2026.6.4`; registry/state bootstrap
still requires an explicitly supplied token and remains read-only.

Supported model providers and credential boundaries are documented in
[`docs/model-providers.md`](docs/model-providers.md).

The OpenClaw-derived provider adaptation audit is tracked in
[`docs/openclaw-provider-adaptation.md`](docs/openclaw-provider-adaptation.md).

The repository now has one executable Cordis composition root for the neutral
HomeWorld bridge runtime and DSH agent. The production Home Agent creates or
resumes its stable session through the official DSH SQLite provider and loads
bounded household prompt context; governed filesystem Skills remain deferred. See
[`docs/architecture-self-review.md`](docs/architecture-self-review.md) for the
verified boundaries and prioritized gaps.
The intended provider authorization and model-selection journey is documented
in [`docs/provider-onboarding.md`](docs/provider-onboarding.md).

DeepSeek `deepseek-v4-flash` has passed one explicit, one-token live probe through
the provider adapter. This validates the API-key transport path, not the still-
pending settings UI or Claude OAuth product flow. Never commit provider keys;
use a scoped environment reference or macOS Keychain profile and rotate any key
that has appeared in chat or logs.
