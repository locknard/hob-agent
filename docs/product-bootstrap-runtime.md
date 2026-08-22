# Product bootstrap runtime

Date: 2026-08-22
Status: accepted direction; implementation follows as the next product milestone

## Decision

HobAgent starts as one Cordis process with one Product Shell. The process moves
through explicit `pairing`, `setup`, `starting`, `operational`, and `recovery`
states. Each state mounts the services it owns inside the same composition root.
The DSH Agent, bridge adapters, observation scheduler, and action plane mount from
one activated configuration generation.

This replaces the current startup assumption that model, bridge, product login,
and storage configuration already exist in the environment. A first-time household
can therefore open the product and complete setup before the Agent becomes active.

## Product journey

1. The first local launch creates a ten-minute pairing code in memory and prints it
   once in the local console. `/setup` asks for that code and establishes an
   HttpOnly, SameSite=Strict private-device session.
2. The household names its home and assistant. This preserves the existing Hob
   self-introduction ritual as the first product moment.
3. Model setup offers supported providers and a custom OpenAI-compatible option.
   The form collects provider, model id, optional HTTPS endpoint, and credential.
   The server performs one bounded paid probe and returns a household-readable
   result.
4. Bridge setup offers registered product bundles. Home Assistant and Xiaomi appear
   as equal adapter choices. Each adapter supplies its own schema-driven fields;
   the Host owns credential collection and scoped storage.
5. A read-only bridge sync produces the real household map. The existing member,
   authority, safety, observation-consent, and first-question checkpoints continue
   from that verified state.
6. Activation commits one configuration generation and enters `starting`. The page
   streams named stages until the operational Product Shell is ready.

## Configuration ownership

- Hub owns a versioned non-secret configuration document under `HOB_DATA_DIR`.
  The file uses owner-only permissions and contains model references, custom
  endpoint metadata, bridge registrations, credential references, and the active
  generation. Commits use an owner-token lock; a fresh owner preserves exclusive
  activation, while an abandoned lock is atomically isolated and recovered after
  a bounded 30-second lease.
- The operating-system credential vault owns model and bridge secret material.
  Browser responses contain availability and probe status only.
- A setup draft has an opaque id, owner principal, revision, expiry, and bounded
  fields. The draft transaction validates schemas, writes scoped credentials,
  probes the selected connection, and commits the non-secret generation.
- Failed probes retain the draft for correction and clean up newly staged secret
  references. Activated generations remain immutable and auditable.
- Credential rotation creates a new staged secret, probes it, then atomically moves
  the active reference. The previous value remains available until activation
  succeeds.

## Runtime composition

| State | Mounted ownership |
| --- | --- |
| `pairing` | loopback HTTP, pairing limiter, setup session owner |
| `setup` | Product Shell, configuration drafts, credential vault, provider and bridge catalogs |
| `starting` | activated configuration, stage stream, bounded recovery controller |
| `operational` | HomeWorld, DSH Agent, review center, advice, media, observation, safety, Product Shell |
| `recovery` | Product Shell, last stable generation, classified repair actions |

State changes occur at the composition root. A configuration activation disposes
the current Cordis fiber in reverse order and mounts the selected generation once.
The Host Shell keeps the same origin and authenticated device session throughout
the change.

## HTTP and security boundary

- Pairing and setup listen on loopback in Phase 0. Network exposure remains an
  explicit deployment decision.
- Every setup mutation requires the paired private-device session, exact same
  origin, bounded form data, optimistic revision, and rate limiting.
- Model and bridge probes use typed server-side ports. Probe responses use closed
  outcomes such as `connected`, `credential_rejected`, `endpoint_unreachable`,
  `incompatible`, and `timed_out`.
- Logs, HTML, URLs, SQLite, configuration documents, DSH traces, and audit summaries
  contain credential references and closed status values. Secret values stay in
  the credential vault and request-local memory.
- Provider and adapter names remain data from registered catalogs. Form input can
  select only registered runtime packages, tools, schemas, and authority classes.

## Implementation slices

1. **Implemented:** the versioned non-secret configuration store commits an
   owner-only, bounded, atomically replaced generation with optimistic revision,
   canonical credential references, secret-shaped field rejection, crash-resilient
   lock recovery, and deterministic tests. The single production `main` reads
   this activated generation whenever deployment environment values leave model
   or bridges unspecified.
2. **Implemented:** launch parsing exposes a bootstrap minimum containing only the
   validated private data directory. The operational parser composes model,
   bridges, credentials, policy and services from the activated generation while
   retaining one `main` and one `HomeAgentRuntime` composition root.
3. Add pairing/session ownership and the `/setup` Host workspace.
4. Connect model setup to the existing Keychain provisioner and DSH profile-scoped
   probe.
5. Connect bridge setup to `BridgeCatalog` schemas and bridge-scoped credentials,
   then run the first read-only sync.
6. Convert activation and recovery stages into the existing streamed Product Shell
   waiting experience.
7. Run browser, restart, credential-rotation, failed-probe, and real HA/custom-model
   acceptance suites.

## Acceptance gates

- A clean private data directory reaches the setup page with only the local process
  and pairing code.
- Setup completes with a custom OpenAI-compatible model and one Home Assistant
  bridge while every secret remains in the credential vault.
- Restart reconstructs the same active generation and device session.
- A failed model or bridge probe leaves the operational generation unchanged.
- Activation mounts one DSH runtime and one selected instance of each configured
  bridge.
- The Product Shell presents continuous setup, starting, recovery, and completion
  feedback on desktop and mobile with reduced-motion and increased-contrast modes.
