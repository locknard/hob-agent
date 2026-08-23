# Product bootstrap runtime

Date: 2026-08-22
Status: accepted target; the current branch implements setup through a verified
connection summary, while activation and the in-process handoff remain the next
milestone

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
4. Bridge setup is catalog-driven. The current product screen offers Home Assistant;
   Xiaomi joins the same choice list when an authorized production transport and its
   setup registration are present. Each adapter supplies its own normalized config,
   display endpoint and scoped credential references.
5. The current read-only bridge probe returns a verified connection summary. The
   next milestone mounts HomeWorld from that exact staged configuration to generate
   the real household map and continue the action-policy, observation-consent and
   first-question checkpoints.
6. The target activation flow mounts the selected generation, commits it, and enters
   `starting`. The page then streams named stages until the operational Product Shell
   is ready.

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

## Target runtime composition

The following table defines the accepted end state. The current branch owns the
`pairing` and `setup` rows through the verified connection summary. The persistent
Host handoff and the remaining rows are the next implementation slice.

| State | Mounted ownership |
| --- | --- |
| `pairing` | loopback HTTP, pairing limiter, setup session owner |
| `setup` | Product Shell, configuration drafts, credential vault, provider and bridge catalogs |
| `starting` | activated configuration, stage stream, bounded recovery controller |
| `operational` | HomeWorld, DSH Agent, review center, advice, media, observation, safety, Product Shell |
| `recovery` | Product Shell, last stable generation, classified repair actions |

In the target runtime, state changes occur at the composition root. One persistent Product Host owns the
loopback listener and the private-device session. Setup and operational services
mount as mutually exclusive child fibers behind that Host; neither child owns a
second listener. A configuration activation first mounts the selected generation,
then commits it as active, then switches the Host surface. A failed mount disposes
the candidate child and leaves the previous active generation unchanged. The Host
keeps the same origin and authenticated device session throughout the change.

The current setup cookie is already scoped to `/`. The target runtime treats it as
the product session; its
durable record contains only a digest, expiry, and the bound local principal. The
operational Product Shell accepts that session directly; the product journey does
not introduce a second Basic-authentication prompt after setup.

Concrete setup support belongs to the ecosystem product bundle. The Hub setup
controller consumes a neutral catalog of registered bridge setup adapters and
stores only their validated config and credential references. Home Assistant,
Xiaomi, and future peers never add product-specific branches to the controller or
HomeWorld.

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

1. **Implemented on the product-bootstrap branch:** the versioned non-secret configuration store commits an
   owner-only, bounded, atomically replaced generation with optimistic revision,
   canonical credential references, secret-shaped field rejection, crash-resilient
   lock recovery, and deterministic tests. The single production `main` reads
   this activated generation whenever deployment environment values leave model
   or bridges unspecified.
2. **Implemented on the product-bootstrap branch:** launch parsing exposes a bootstrap minimum containing only the
   validated private data directory. The composition root classifies `setup` or
   `operational` from non-secret metadata and reports only the activated generation.
   The operational parser composes model, bridges, credentials, policy and services
   from that generation while retaining one `main` and one `HomeAgentRuntime` root.
3. **Implemented on the product-bootstrap branch:** pairing/setup-session ownership and
   the `/setup` workspace cover the one-time pairing claim, household identity,
   restartable non-secret draft, bounded forms, and a local attempt limiter.
4. **Implemented on the product-bootstrap branch:** model setup stages a scoped
   Keychain reference and runs a DSH profile-scoped probe without replacing the
   active model profile.
5. **Implemented on the product-bootstrap branch:** a neutral bridge setup catalog
   stages bridge-scoped credentials and runs a Home Assistant authenticated,
   read-only map probe without subscribing or writing.
6. **Foundation implemented on the product-bootstrap branch:** one reusable
   `ProductHttpHost`, an exact activation candidate, and a mountable Home Agent child
   bundle. Next, compose them into the persistent Host, mount-before-commit
   transition, product-session authentication, and continuous
   `starting`/`recovery` feedback.
7. Run browser, restart, credential-rotation, failed-probe, and real HA/custom-model
   acceptance suites before declaring the milestone complete.

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
