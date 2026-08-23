# Product bootstrap runtime

Date: 2026-08-22
Status: current Phase 0 runtime. The single supervisor serves first-run setup,
active generations, local session recovery, and operational model and voice
maintenance.

## Decision

HobAgent starts as one Cordis process with one Product Host. The
`ProductRuntimeSupervisor` owns the local listener and presents pairing, setup,
starting, operational, and recovery product states from one composition root.
The DSH Agent, bridge adapters, observation scheduler, and action plane mount
from one activated configuration generation.

A first-time household opens the product and completes setup before the Agent
becomes active. An activated household starts from its saved generation; launch
environment model and bridge values remain available to diagnostic CLI commands
and do not form a production direct-start path.

## Product journey

1. The first local launch creates a ten-minute pairing code in memory and prints it
   once in the local console. `/setup` asks for that code and establishes an
   HttpOnly, SameSite=Strict private-device session.
2. The household names its home and assistant. This preserves the existing Hob
   self-introduction ritual as the first product moment.
3. Model setup offers supported providers and a custom OpenAI-compatible option.
   The form collects provider, model id, a validated private endpoint when the
   provider requires one, and credential.
   The server performs one bounded paid probe and returns a household-readable
   result.
4. Bridge setup is catalog-driven. The current product screen offers Home Assistant;
   Xiaomi joins the same choice list when an authorized production transport and its
   setup registration are present. Each adapter supplies its own normalized config,
   display endpoint and scoped credential references. Its read-only probe returns a
   verified connection summary before setup advances.
5. Private voice is optional. A household can verify independent ASR and TTS
   tracks through Wyoming or local OpenAI-compatible endpoints, or choose to
   continue with text. Credentials remain track-scoped in the system vault.
6. Activation mounts HomeWorld from that exact staged revision, then continues in the real
   onboarding flow at bridge preflight, household map, action policy,
   observation consent, and the first question. The household and assistant names
   already accepted during setup are carried forward once and are not requested again.
7. Activation mounts the selected generation, commits it, rotates the short setup
   cookie into a durable local product session, and switches the same Product Host
   to the operational Product Shell. A lost browser session returns to a local,
   rate-limited one-time pairing flow without remounting the Agent. Model and
   private-voice checks, recovery, cancellation, and reconfiguration continue in
   the background with a current-state receipt for the paired browser.

## Configuration ownership

- Hub owns a versioned non-secret configuration document under `HOB_DATA_DIR`.
  The file uses owner-only permissions and contains model references, custom
  endpoint metadata, bridge registrations, optional ASR/TTS references, and the
  active generation. Commits use an owner-token lock; a fresh owner preserves exclusive
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

The Product Host presents the following states while the supervisor retains one
listener and one lifecycle owner.

| State | Mounted ownership |
| --- | --- |
| `pairing` | loopback HTTP, pairing limiter, setup session owner |
| `setup` | Product Shell, configuration drafts, credential vault, provider and bridge catalogs |
| `starting` | activated configuration, stage stream, bounded recovery controller |
| `operational` | HomeWorld, DSH Agent, review center, advice, media, observation, safety, Product Shell |
| `recovery` | Product Shell, local session pairing or last stable generation, classified repair actions |

State changes occur at the composition root. One persistent Product Host owns the
loopback listener and the private-device session. Setup and operational services
mount as mutually exclusive child fibers behind that Host; neither child owns a
second listener. A configuration activation first mounts the selected generation,
then commits it as active, then switches the Host surface. A failed mount disposes
the candidate child and leaves the previous active generation unchanged. The Host
keeps the same origin and authenticated device session throughout the change.

The setup cookie is scoped to `/`. Successful activation rotates it into a
longer-lived operational token; the durable session record contains only a digest,
expiry, and the bound local principal/device. The operational Product Shell accepts
that session directly. A missing or expired cookie redirects a read request to the
same-origin `/pair` recovery page; redeeming the short-lived code atomically rotates
the token and invalidates the old one. The product journey does not introduce a
Basic-authentication prompt after setup.

Concrete setup support belongs to the ecosystem product bundle. The Hub setup
controller consumes a neutral catalog of registered bridge setup adapters and
stores only their validated configuration and credential references. Home
Assistant is available in the current product catalog; an authorized adapter
joins through the same catalog seam.

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

## Delivered runtime slices

1. The versioned non-secret configuration store commits an
   owner-only, bounded, atomically replaced generation with optimistic revision,
   canonical credential references, secret-shaped field rejection, crash-resilient
   lock recovery, and deterministic tests. The single production `main` always
   starts the ProductRuntimeSupervisor, which selects setup or the saved active
   generation.
2. Launch parsing exposes a bootstrap minimum containing only the
   validated private data directory. The composition root classifies `setup` or
   `operational` from non-secret metadata and reports only the activated generation.
   The operational parser composes model, bridges, credentials, policy and services
   from that generation while retaining one `main` and one
   `ProductRuntimeSupervisor` root. The operational Home Agent is one mounted child
   bundle, not a second runtime owner.
3. Pairing/setup-session ownership and
   the `/setup` workspace cover the one-time pairing claim, household identity,
   restartable non-secret draft, bounded forms, and a local attempt limiter.
4. Model setup stages a scoped
   Keychain reference and runs a DSH profile-scoped probe without replacing the
   active model profile.
5. A neutral bridge setup catalog
   stages bridge-scoped credentials and runs a Home Assistant authenticated,
   read-only map probe without subscribing or writing.
6. One `ProductRuntimeSupervisor`
   owns the Cordis root and loopback listener. It mounts the exact map revision before
   committing it, atomically hands the Host to the Product Shell, reuses the paired
   product session without Basic authentication, disposes the setup surface, restores
   an active generation after restart, and carries household identity into onboarding.
   The retired standalone setup runtime has been removed.
7. Optional private voice setup independently verifies
   ASR and TTS, commits only credential references, mounts one provider-neutral
   runtime, and sends final transcripts through the existing DSH advice loop. A
   provider outage on restart degrades voice while text and the household product
   remain operational.
8. Activation rotates the setup cookie into an owner-only
   durable product session. A one-time, same-origin local recovery route rotates a
   lost browser token; malformed cookies, parallel code redemption, and repeated
   failures remain bounded.
9. Operational model and private-voice settings verify a candidate in the
   background, allow cancellation, retain the active generation during a failed
   candidate, and replace a ready generation without remounting the DSH Agent.
   Each retiring credential has an exact cleanup ledger entry. The active
   runtime performs a bounded cleanup pass after drain; a stop leaves any
   pending exact entries durable, and the next startup continues them in a
   bounded pass.

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
