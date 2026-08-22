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
   registration and concrete HA, Xiaomi and synthetic adapters. Adapters emit the
   neutral contract event stream and capability declarations.
2. `artifact/` owns neutral artifact schemas, evidence, risk, conflict, compilation,
   preparation, registry, mutation coordination, capability compatibility policy
   and the read-only adapter from a neutral world cut into artifact authority
   assessment.
3. `authority/` owns principals, governance records, state/action authority,
   candidate authority and one-shot action policy/store.
4. `media/` owns neutral media catalog, player discovery, play intent and Music
   Assistant integration.
5. `world/` owns bridge event ingestion, ingest journals, world identity,
   state/index projection and the neutral HomeWorld service.
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
- Production source in `bridge/` has no dependency on `artifact/` or `world/`;
  capability declarations flow into artifact assessment, and neutral events flow
  into the world-owned ingest.
- Production source in `world/` has no dependency on `artifact/`; artifact-owned
  adapters read the neutral HomeWorld port when an assessment needs evidence.
- Production source in `authority/` has no dependency on `world/`; authority owns
  shared governance records and world identity emits records through those types.
