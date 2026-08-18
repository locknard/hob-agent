# hob-agent

An agent-first smart-home hub. Phase 0 connects to an existing Home Assistant
instance and turns observations into reviewable, reversible proposals.

## Workspace

- `packages/hub`: Home Assistant bridge, event ingestion, and core services.
- `packages/agent-layer`: agent prompts, governed tools, and audit boundaries.
- `packages/inbox-web`: proposal inbox web application.
- `contracts`: versioned bridge-contract types.
- `home-template`: editable home knowledge workspace template.

## Getting started

```sh
pnpm install
pnpm check
```

The repository is in Phase 0. The Cordis-hosted DSH read-only Home Agent, Home
Assistant bridge, provider credential/profile foundations, and governed home
snapshot tool now have executable tests; proposal application and device control
remain deliberately unavailable.

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
events. Configure these values locally; never commit a token:

```sh
export HOB_HA_URL=http://homeassistant.local:8123
export HOB_HA_TOKEN='long-lived-access-token'
export HOB_MODEL=deepseek/deepseek-v4-flash
export DEEPSEEK_API_KEY='...'
# or select the matching OPENAI_API_KEY / ANTHROPIC_API_KEY / MOONSHOT_API_KEY / ZAI_API_KEY
pnpm start
```

DeepSeek Harness (DSH) is the project's only Agent Runtime. It owns the agent
loop, session, prompt assembly, tool registry, and cancellation lifecycle. The
Home Product Bundle currently contributes only the read-only
`get_home_snapshot` tool. Device actions, configuration writes, and proposal
application are deliberately not implemented in this first slice.

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

The repository now has one executable Cordis composition root for the DSH/HA
service. Live HA world-state updates, session persistence, and household
prompt/Skill loading remain open; see
[`docs/architecture-self-review.md`](docs/architecture-self-review.md) for the
verified boundaries and prioritized gaps.
The intended provider authorization and model-selection journey is documented
in [`docs/provider-onboarding.md`](docs/provider-onboarding.md).

DeepSeek `deepseek-v4-flash` has passed one explicit, one-token live probe through
the provider adapter. This validates the API-key transport path, not the still-
pending settings UI or Claude OAuth product flow. Never commit provider keys;
use a scoped environment reference or macOS Keychain profile and rotate any key
that has appeared in chat or logs.
