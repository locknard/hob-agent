# Hub source layout

Date: 2026-08-22
Status: accepted internal organization

## Purpose

`packages/hub` owns one deployable Hub with several cohesive internal domains. Its
source tree mirrors those ownership boundaries so a reviewer can identify the state,
authority and adapter surface affected by a change before reading implementation
details. Tests stay beside the implementation they protect.

Directory organization changes import paths only. Package exports, runtime service
names, SQLite formats, Cordis composition, neutral contracts and command authority
remain stable through each move.

## Phased organization

1. `bridge/` owns adapter catalog and bundle composition, bridge credentials,
   registration, ingestion, capability semantics and concrete HA, Xiaomi and
   synthetic adapters.
2. `artifact/` owns neutral artifact schemas, evidence, risk, conflict, compilation,
   preparation, registry and mutation coordination.
3. `authority/` owns principals, identity authority, action authority, candidate
   authority and one-shot action policy/store.
4. `media/` owns neutral media catalog, player discovery, play intent and Music
   Assistant integration.
5. `world/` owns ingest journals, world identity, state/index projection and the
   neutral HomeWorld service.
6. `home/` owns household-facing advice, correction, proposal, safety, onboarding,
   observation, retention, review and batch services.
7. `cli/` owns executable setup, validation and one-shot operational commands.
8. `foundation/` owns small bounded deterministic utilities shared by domains;
   it contains no runtime service, persistence owner or external integration.

Each phase moved one complete dependency cluster, updated all repository consumers,
ran the full test/type suite and landed as one reviewable commit. Composition roots
(`main.ts`, `process-entry.ts`, `home-agent-runtime.ts`, `launch-config.ts`) remain at
the source root and make domain dependencies visible.

## Import rules

- Hub imports the neutral bridge boundary from `@hob/bridge-contract`.
- A domain uses relative imports within its directory and `../` for another Hub
  domain or root composition module.
- Repository code imports Hub implementation through its current source path only
  while the package remains private. Public package subpaths enter through an
  explicit export and dependency decision.
- Architecture tests recurse through every domain directory and keep concrete
  adapter vocabulary inside `bridge/` plus the explicit product bundle.
