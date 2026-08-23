# Operational model-provider lifecycle

## Decision

The `ProductRuntimeSupervisor` owns every first-run and activated product
mount. Phase 0 runs one `DshHomeAgentService`, one DSH `AgentLoop`, and one
persisted session beneath that supervisor. The root `LlmRuntime` exposes exactly
one stable virtual route and model to that agent. Its adapter delegates a
request to an immutable provider generation selected before a product activity
begins.

The stable route is an internal runtime detail. Session headers, prompts,
traces, and product API responses contain neither provider endpoints nor secret
references nor generation identifiers.

## Invariants

- A single Home Agent owns all session state, tool steps, retries, compaction,
  and idleness waiting. A provider generation never creates an `AgentLoop` or
  an agent.
- Each generation owns an isolated Cordis context containing
  `DshProfileCredentialProvider`, `LlmRuntime`, and the official
  `dsh-llm-pi-ai` plugin. The context receives only that generation's
  provider/model/profile configuration.
- The root virtual adapter resolves its target from an immutable DSH turn
  lease. It does not perform a mutable active-generation lookup for a model
  step. A root metadata query without a live turn receives only the stable
  virtual identity, never a physical generation's capacity or route.
- The resolver observes the Home Agent's durable `turn/start` and `turn/end`
  session facts. It acquires the exact generation at `turn/start`, binds that
  generation to the turn signal in a prepended `agent/pre-step` listener before
  prompt assembly and automatic compaction, and releases it at `turn/end`,
  `agent/error`, or signal abort. A follow-up begins a new turn and therefore
  cannot inherit a prior turn's generation.
- `requestAdvice` and `requestObservation` check resolver availability before
  they begin a deadline, budget, report, or coverage owner. A degraded request
  leaves those owners untouched; a later ready request starts normally.
- Activating a ready candidate makes it the target for later turns. Existing
  turns keep their prior target. A retired generation disposes only after its
  final turn lease releases.
- A failed candidate leaves the current active generation unchanged. When no
  active generation is available, resolver status is `degraded` and new product
  activities fail closed. UI ownership remains available to display status and
  offer retry or activation.
- Resolver disposal cancels and waits for pending preparations, discards every
  unconsumed prepared child, retires every active generation, and waits for
  every already-retired child context. A late child from a cancelled or closed
  preparation disposes before its preparation settles. Cleanup failures remain
  observable; they never reverse an already committed active pointer.
- A Hub may create, prepare, commit, and retain one resolver before mounting
  the Home Agent composition. The composition receives that exact resolver in
  either `ready` or `degraded` state, registers only its stable adapter, and
  never creates a replacement resolver, Agent, loop, or session. A degraded
  injected resolver keeps UI ownership and retry available while blocking new
  model work. The Hub remains the injected resolver's lifecycle owner; the
  legacy composition owns only the resolver it creates.

## States and transitions

`degraded` has no active generation and blocks new turns.
`ready` has an active generation and admits new turns.

1. The Hub supplies a validated candidate generation to
   `prepare(candidate, signal?)`. The optional signal cancels mounting and
   route verification; any child that appears after cancellation is disposed.
2. `prepare` mounts its isolated context and verifies the exact DSH route and
   model without changing the active pointer. The Hub may probe it, reject it
   with `discard(prepared)`, or retain it while completing durable config CAS.
3. After config CAS, `activate(prepared)` consumes that exact prepared object,
   atomically makes it active, and performs no asynchronous mount or disposal
   work. It returns a branded transition with an opaque predecessor number and
   a `drained` promise.
4. New turns select the new generation immediately. `drained` settles only
   after the predecessor's final turn lease releases and its isolated context
   has finished disposal. A disposal failure rejects `drained`; it never rolls
   the active pointer back.
5. A failed build, failed activation, or explicit `degrade()` results in
   `degraded` only when no generation remains active. A replacement failure
   preserves the previous `ready` generation.
6. Parent shutdown retires the active generation and waits for every already
   retired generation's runtime drain. A finishing Home Agent turn releases its
   exact lease from the DSH turn lifecycle, allowing shutdown to complete without
   disposing that turn's child runtime early. Credential cleanup records remain
   durable: the next supervisor startup performs the next bounded exact-ref
   cleanup pass.

## Small seam

`ModelProviderResolver` deliberately exposes only:

- `prepare(candidate, signal?)` to mount and verify a Hub-selected candidate
  before its durable configuration commit;
- `activate(prepared)` for the synchronous post-CAS pointer swap;
- `discard(prepared)` to dispose a cancelled, rejected, or failed-CAS
  candidate;
- `retry(candidate)` as a convenience alias for non-settings callers;
- `status()` for operational state without credentials;
- `acquire()` for a narrow resolver-level lease owner; the Home Agent uses
  `bindAgent(agent)` instead so no whole-driver lease can cross turns;
- `bindAgent(agent)` for the one Home Agent's DSH turn boundary; and
- `adapter` for registration on the one root virtual route.

`activate` returns a branded transition rather than a caller-made status
object. `retry` uses prepare-and-activate only as a convenience; settings must
use the explicit prepare/CAS/activate sequence. The Hub records and awaits
`transition.drained` before deleting old credential material. It can keep a
rejected drain in its cleanup ledger for recovery while the new generation
remains active.

The candidate includes the selected provider, model, optional custom endpoint,
API-key profile, and vault. It is an internal composition input, not session
metadata. The Hub constructs candidates from persisted profile records, probes
them before activation, and projects resolver status without adding another
provider framework or remounting the Home Agent.

## First-run draft ownership

A successful first-run probe transfers the exact staged model credential to the
durable setup draft. Pairing-session expiry pauses browser access while the same
draft remains resumable after a fresh local pairing. A transient activation
failure likewise keeps the verified candidate available for a direct retry.
These states preserve a household's completed setup work and do not represent
abandonment.

A future explicit “重新开始设置” or “放弃这次设置” action must be a terminal
draft transition. The draft store will atomically move every draft-owned model
and voice credential reference into its cleanup ledger, excluding any exact
reference already owned by the active product configuration, before it creates
a new draft. Cleanup remains bounded and replayable across restart. Session
expiry alone never triggers that transition.

## Cleanup sequence

1. `turn/start` captures one active generation before prompt assembly or
   compaction; `agent/pre-step` attaches its signal to that exact generation.
2. `turn/end`, turn error, or abort releases only that generation.
3. If a retired generation reaches zero leases, its Cordis fiber is disposed
   and the transition's `drained` promise settles only after disposal settles.
4. Parent disposal cancels pending preparation work, drains every prepared and
   retired child, and leaves any disposal rejection observable to its owner.
5. The model cleanup ledger retains each exact retired credential until a
   bounded vault deletion succeeds. A stopped process leaves that durable work
   for the next supervisor startup, which resumes it without scanning or
   deleting active references.

This ordering keeps in-flight work credential-stable while preventing old
provider contexts from surviving after their final request completes.

## Household settings feedback

The household Settings page describes the model by its purpose: it understands
questions and generates answers and new suggestions. Connecting or replacing a
model service is one level deeper, and the page never renders credential values
or references.

Candidate checks and recovery each have one HTTP-owned, opaque task identity.
The authenticated, same-origin page polls that task while it is pending and
redirects through a one-time receipt only after it reaches active, degraded, or
cancelled. A wait longer than ten seconds keeps the task running in the
background, exposes household-state and activity exits, and offers a direct
stop action. The recovered or unavailable result is then rendered from the
current Hub projection rather than leaving the page on an old “recovering”
state.

The served product stylesheet has one canonical operational-model extension:
`packages/inbox-web/src/product.css`, loaded beside the source HTTP module and
combined with the existing shared shell stylesheet. This private source package
exports its TypeScript runtime directly, so the sibling-asset path remains part
of the same runtime publication boundary.
