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

The repository is intentionally a Phase 0 scaffold: it establishes module
boundaries and the file-first home workspace before runtime behavior is added.
