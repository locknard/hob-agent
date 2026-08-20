# M3a Proposal Review Loop

## Decision

The next product milestone is the first durable, reviewable household proposal
loop. It turns neutral bridge observations into bounded evidence, lets the DSH
Home Agent create a pending proposal, and gives the household an Inbox in which
to approve or reject it.

This milestone does **not** execute a device action or install an automation.
Approval records human intent; a later milestone must still pass the approved
proposal through policy, artifact generation, execution, rollback, and audit
boundaries.

## Why this is next

The runtime, bridge contract, Home Assistant adapter, Xiaomi adapter, world
model, and DSH loop now exist. More runtime abstraction would not yet improve a
household outcome. The missing product proof is whether the agent can make one
useful recommendation from real home evidence without silently expanding its
authority.

A pre-normalization read-only discovery aggregate on 2026-08-19 found 606
current states, 839 registered entities, 80 device-registry rows, seven raw
areas, and 15 automation entities. The later committed Agent-visible cut has
75 neutral devices, 540 accepted current states, six neutral spaces, and 12
visible configured rules after invalid/unavailable placeholders and projection
rules are applied. Only aggregates are recorded here;
entity names, state values, credentials, and household identifiers remain
outside the repository. Existing automations make deduplication and conflict
reporting release requirements rather than later enhancements.

## Ownership

- `packages/hub` owns proposal persistence, evidence projection, lifecycle
  validation, review audit, and the fail-closed boundary between approval and
  application.
- `packages/agent-layer` contributes a governed `create_home_proposal` DSH tool.
  The tool can create a pending proposal only. It receives a narrow service
  interface and does not import SQLite or bridge-specific implementations.
- `packages/inbox-web` renders the local proposal list, detail, evidence, DSH
  trajectory, and approve/reject controls. It is a review surface, not a second
  policy engine or runtime.
- Bridge adapters remain neutral observation providers. Neither Home Assistant
  nor Xiaomi owns proposal semantics.

## Proposal envelope v1

Every proposal is a bounded, versioned envelope with:

- a generated proposal ID, revision, creation/update timestamps, and lifecycle
  status;
- a bounded kind, title, summary, and structured intended change;
- for every new Agent-created proposal, a bounded model-authored household
  rationale stating expected value, why it is timely, and one to six explicit
  uncertainties; the Inbox labels this as the Agent's case rather than Hub
  evidence;
- a Hub-bound aggregate showing whether each selected device has exactly one,
  no, or multiple accepted neutral spaces, so incomplete household mapping
  cannot be hidden by the Agent's rationale;
- immutable provenance identifying the producer and, when applicable, the DSH
  session and root tool call;
- evidence references and per-bridge watermarks rather than copied raw events;
- freshness and gap declarations so missing evidence cannot look conclusive;
- a stable idempotency key and explicit duplicate/conflict findings;
- dry-run status and a bounded human-readable result;
- risk level, reasons, required approval, and rollback description;
- review metadata and an append-only audit trail.

The initial lifecycle is:

```text
pending_review -> approved
               -> rejected
               -> expired
```

Terminal review decisions cannot be overwritten. Optimistic revision checks
prevent stale tabs or concurrent agents from winning silently. Repeating the
same producer/idempotency key returns the existing proposal instead of filling
the Inbox with equivalent suggestions.

New manual reviews also carry bounded decision-specific feedback. Approval
records “useful as-is”; rejection distinguishes an already-covered suggestion,
low value, an incorrect assumption, insufficient evidence, a household
preference mismatch, excessive risk, or another reason with a required note.
The code is persisted in the review and append-only audit event. Older v1 rows
without structured feedback remain readable. Feedback never changes household
knowledge, prompts, policy, or device authority automatically.

M3a does not yet have an automation artifact to simulate. Hub-created drafts
therefore report dry-run status `not_run`; “nothing was applied” must never be
misreported as a passed simulation. Only a later Hub-owned artifact compiler
and simulator may emit `passed` or `failed`.

`toolCallId` stores DSH's `rootCallId` for exact trace correlation. Early local
v1 rows mislabeled that value as `turnId`; readers retain that optional legacy
field, but new proposals never claim a tool-call identity is a turn number.
The Inbox resolves that call to its containing DSH turn and displays only the
turn-local metadata trace and token usage, not cumulative session totals.

## Evidence and privacy rules

Evidence queries are served from Hub-owned local state, not directly from a
vendor API. Current-state references come from the world model. Temporal
evidence comes from a SQL-bounded journal query over selected current hub
capability bindings and only includes state changes after the current epoch's
verified `sync-complete`; bootstrap rows never count as behavior. Queries and
results are bounded by count and time window. Evidence records use neutral
bridge/device/capability identities, include bridge epoch and sequence
provenance, and expose missing, gapped, baseline-limited, or truncated coverage.

Existing platform rules arrive only through the optional neutral
`foreignRules@2` extension. Its catalog declares the replay epoch and exact
last sequence (`epochId + lastSeq`) that produced it; the Hub accepts a conflict
check only when that exact pair matches the bridge's committed consistent
watermark. A restart, partial replay, missing extension, invalid/incomplete
catalog, or epoch/sequence mismatch fails closed instead of reporting zero
conflicts.
Home Assistant entities explicitly marked as restored placeholders while
unavailable are excluded because they no longer represent configured rules;
ordinary disabled rules remain in the catalog and can still overlap a draft.

Proposal content is household data and remains local by default. SQLite files
and WAL/SHM sidecars use mode `0600`. Credentials, raw bridge payloads,
unbounded attributes, and hidden model reasoning are never stored in the
proposal database. Inbox traces contain metadata-safe DSH loop events only.

## Acceptance slice

M3a is complete when a local run can:

1. ingest the real Home Assistant instance through the existing read-only
   bridge and world model;
2. obtain bounded evidence with watermarks and freshness/gap status;
3. create one pending proposal through the DSH governed tool with duplicate and
   existing-automation conflict findings;
4. restart without losing the proposal or audit history;
5. list and inspect it in the Inbox beside its metadata-safe DSH trajectory;
6. approve or reject it with optimistic concurrency, structured household
   feedback, and an audit record; and
7. demonstrate that approval cannot execute a device action or install an
   automation.

Tests use deterministic fixtures. Real household validation writes only to a
private data directory outside the repository and reports aggregate results.

## Deferred

- applying approved proposals;
- device control and automation installation;
- automatic rollback execution;
- semantic scheduling/energy optimization;
- Code Mode or a second runtime;
- bridge-specific proposal engines.

## M3b authenticated local delivery

The HTML/controller slice is not an authorization boundary by itself. Browser
delivery therefore remains disabled unless an explicit local Inbox credential
is configured. The first HTTP delivery contract is deliberately narrow:

- bind only to `127.0.0.1`; the host is not configurable;
- use an explicit 32-or-more-character secret and compare only a derived digest;
- require authentication for every list, detail, and review request;
- never place the credential in a URL, HTML response, error, trace, or launch
  snapshot;
- require an exact same-origin `Origin` for review POSTs, form content type, and
  a 4 KiB request-body limit;
- derive reviewer identity from the authenticated local endpoint, never from a
  model or form field;
- emit no-store, no-referrer, frame-denial, nosniff, and restrictive CSP headers;
- map stale revisions to conflict and all arbitrary internal failures to a
  redacted response; and
- expose approve/reject only. HTTP delivery does not add an apply route.

Port `0` is a test-only seam. Production launch accepts an explicit local port
or uses the documented default. Missing authentication configuration keeps the
listener absent while the same-root Inbox service remains available to local
composition code.
