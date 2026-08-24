# Proposal preparation pipeline

Status: accepted and implemented for the non-applying Hub runtime slice.
The production composition owns the durable stores and wakes preparation after
admission of a qualifying automation Proposal during that running process.
Preparation is prepare-first: the Proposal remains pending review while the
Hub builds and checks its exact Artifact. A household decision opens only after
the exact preparation succeeds and the Proposal is promoted to `ready`.
The raw Proposal envelope keeps its admission-time `dryRun: not_run` value;
the exact compiler and simulator facts live in the separate read-only
`ArtifactReviewSnapshot`.

## Decision

A qualifying automation Proposal admission with a valid neutral
`artifactCandidate` durably enqueues exactly one Hub-private preparation job
for that admitted Proposal revision. Admission does not approve, enable,
install, execute, or roll back anything. It records the raw Proposal with
`dryRun.status: "not_run"` and starts the preparation lifecycle.

The root-private background worker executes the job in this fixed order:

```text
admitted Proposal revision (`lifecycle: preparing`)
  -> Artifact
  -> evidence
  -> authority
  -> risk
  -> compile
  -> dry-run
```

The first four stages use the existing Hub-owned producer seams. `compile`
also obtains the bounded current-conflict capture and neutral world cut needed
by the M3c compiler; those are read-only compiler inputs, not additional public
pipeline stages. The final result remains a neutral, durable review record.
There is no device write, remote rule installation, action ticket, executor,
`actions@1`, or `artifactHost@1` in this slice.

The worker records prepared Artifact, assessment, compile, and dry-run
references on the exact Proposal revision. The Proposal Store promotes that
revision to `ready` only after compile and dry-run persistence succeeds. Only a
`ready` Proposal can spend household attention on a review or enablement
decision. The raw Proposal `dryRun` field is not rewritten by this promotion;
`HomeArtifactService` reads the independent ArtifactReview attestation by
exact `proposalId + proposalRevision`.

This decision extends the review-only boundary described by
[`proposal-review-loop.md`](proposal-review-loop.md),
[`artifact-proposal-candidate.md`](artifact-proposal-candidate.md), and
[`neutral-artifact-contract.md`](neutral-artifact-contract.md). It does not
turn Proposal approval into Artifact approval or execution approval.

## Admission and preparation boundary

Only an admitted `automation-draft` with a valid neutral `artifactCandidate`
qualifies for this preparation job. Insights, identity proposals, and other
non-automation kinds remain review metadata and do not create an Artifact job.

The Hub admission boundary must:

1. validate the bounded Proposal, candidate, evidence, conflict, and human
   approval requirements;
2. persist the pending Proposal and exactly one job keyed by its admitted
   `(proposalId, proposalRevision)` in the Proposal Store transaction;
3. return the pending Proposal with `lifecycle: preparing` and raw
   `dryRun.status: "not_run"`; and
4. wake the private worker after the durable admission commits.

The admission and enqueue writes share one Hub-owned Proposal Store transaction
so a successful admission cannot be observed without its durable job. If that
boundary cannot commit, the Proposal fails closed before it becomes visible.
The wake is best effort after the durable write; an explicit retry handles a
failed job, and startup does not claim old queued jobs.

While preparation runs, the Proposal remains `pending_review` with
`lifecycle: preparing`. A failed preparation attempt leaves that state and
records only the bounded job stage and error code. It does not approve, reject,
expire, or rewrite the Proposal; it does not delete, supersede, or compensate
an already persisted Artifact or assessment row. The rollback field inside the
reviewed neutral Artifact candidate is intent for the governed action plane
and is never executed by preparation.

Repeated admission delivery is handled by the existing Proposal
idempotency/dedup checks and the same enqueue identity. It returns the existing
durable result or a bounded conflict; it never creates a second job for the
same admitted revision. A household decision is accepted only after the exact
revision is `ready`; automation enablement then uses its separate governed
deployment boundary.

## Durable job contract

The job queue is Hub-private durable state. It stores references and bounded
lifecycle metadata, not a copy of the Proposal, model output, raw bridge data,
native identifiers, credentials, or arbitrary exception text. The admitted
Proposal remains the exact source read by the Artifact producer.

The minimum v1 shape is conceptually:

```ts
type ApprovedProposalPreparationJob = {
  schemaVersion: "1";
  kind: "approved-proposal-preparation";
  jobId: BoundedHubId;
  proposalId: BoundedHubId;
  proposalRevision: PositiveSafeInteger;
  idempotencyKey: BoundedHubId;
  status: "queued" | "running" | "succeeded" | "failed";
  attempt: PositiveSafeInteger;
  stage?:
    | "artifact"
    | "evidence"
    | "authority"
    | "risk"
    | "compile"
    | "dry-run";
  artifact?: ArtifactRef;
  error?: {
    stage: "artifact" | "evidence" | "authority" | "risk" | "compile" | "dry-run";
    code: BoundedPreparationErrorCode;
  };
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
};
```

`status` is a closed set. A job is `queued` before a worker claims it,
`running` for one claimed attempt, `succeeded` only after both compile and
dry-run rows have been durably recorded and cross-checked, and `failed` when a
bounded stage error prevents completion. There is no `applying`, `installed`,
`enabled`, `executing`, or `rollback` job state in this slice.

The implementation fixes finite limits for job payload size, error text (if a
human summary is retained), attempt count, and retained job/audit rows. Stage
and error values are closed enums such as `not_found`, `unavailable`,
`malformed_dependency`, `policy_blocked`, `persistence_failed`, and
`attempt_exhausted`. Raw provider, bridge, filesystem, or model errors do not
cross the job or Inbox projection.

The queue is physically co-located with the Proposal store to provide the
admission/enqueue transaction. It is not an Artifact Registry and is not a
second source of Artifact truth. Its only mutation responsibility is job
lifecycle and bounded job audit.

## Pipeline ownership and stage contracts

The preparation worker owns sequencing and holds the only writable composition
handle to the Artifact Registry. Producers receive narrow typed ports; they do
not open SQLite, select a route, or call a bridge. Every Artifact, assessment,
compile, and dry-run write is validated, idempotent, append-only, and audited by
the Hub-owned `ArtifactRegistry`.

| Stage | Hub-private work | Durable output | Forbidden effect |
| --- | --- | --- | --- |
| `artifact` | Re-read the exact admitted Proposal through the Hub source gate; copy its reviewed title, summary, and candidate; let Hub generate the Artifact identity | Artifact revision 1 / `draft` | No candidate reinterpretation, bridge call, or device write |
| `evidence` | Re-read the exact Artifact and admitted Proposal source; query a fresh bounded HomeWorld/evidence cut | Immutable `evidence-attestation` | No Agent-authored watermark or raw event copy |
| `authority` | Build a fresh opaque Hub-private binding input; resolve exactly one candidate per device-action capability through `AuthorityCandidateRegistry` | Immutable `authority-assessment` | No route, native ID, credential, or fallback authority in neutral output |
| `risk` | Re-check exact evidence and authority identities; run the fixed Hub policy and bounded conflict source | Immutable `risk-assessment` | No model risk label or missing-conflict-as-zero inference |
| `compile` | Re-read exact dependencies, capture the current conflict cut, create a stable neutral world cut, and run the pure compiler | Immutable `compile-attestation` | No provider payload, action ticket, or remote call |
| `dry-run` | Run the pure neutral simulator against that compile result | Immutable `dry-run-attestation` | No bridge control/events write, credential resolve, executor, or artifact host |

The causal production order is fixed even though the compiler coordinator
reads already persisted dependencies in its own validation order. In
particular, risk cannot be produced without the exact evidence and authority
rows, and compile cannot run without all three assessments and its fresh
read-only conflict/world inputs. Missing, stale, malformed, or mismatched
inputs fail the job at the owning stage.

`ArtifactRegistry` is the sole owner of Artifact revision, evidence,
authority, risk, compile, and dry-run records. The preparation worker composes
calls to that Registry; it does not maintain a shadow Artifact map, and
Proposal, Agent, Inbox, plugin, authority configuration, and bridge code do not
write those records. `AuthorityCandidateRegistry` remains a separate
Hub-private opaque candidate store as defined by
[`authority-candidate-registry.md`](authority-candidate-registry.md); its
candidate rows never become Artifact ownership or an execution route.

## Idempotency, retry, and restart

There are two distinct idempotency layers:

- **Enqueue identity:** the Hub derives a stable key from the existing
  `approved-proposal-preparation-v1` job identity material, `proposalId`, and
  the exact admitted Proposal revision. The persisted kind/key name remains
  stable while the admission boundary owns when the job is created. A replay
  returns the existing job and does not append a second queue row.
- **Stage identity:** Artifact Registry writes use the existing deterministic
  keys for the exact ArtifactRef and assessment/result input identities. A
  retry re-reads fresh HomeWorld inputs and therefore produces a new immutable
  assessment/result identity when those inputs change; replaying the same input
  returns the original row without duplicate audit.

Retry is an explicit Hub-private command, never an automatic timer or
backoff. It requires the expected job state/version and a deterministic retry
identity derived from the job and next attempt. A successful duplicate retry
request with a stale expected version returns a bounded conflict. A retry can move a failed attempt
back to `queued`; a `running` attempt left by a crash can be retried only after
an explicit bounded claim/lease check. Concurrent retry requests cannot create
two running attempts. The attempt counter has a finite maximum; after that
limit the job remains `failed` and requires a new human-reviewed Proposal if a
new attempt is needed.

Preparation retries start at the `artifact` stage and are safe because prior
Artifact Registry rows are immutable and each producer is idempotent. A
partial run is not rolled back. For example, if compile persistence succeeds
and dry-run persistence fails, the compile row remains; an explicit retry
reuses it when its input identity matches and only fills the missing dry-run
result. This follows the existing coordinator contract and preserves a
complete audit trail.

Process startup only opens and validates durable stores and reports bounded
diagnostics. It does not scan for queued jobs, claim running jobs, resume a
stage, or invoke a producer. A job enqueued during an already running process
wakes that process's explicitly mounted worker; that event is not startup
replay. Jobs left `queued` or `running` by shutdown remain so until an
explicit, operator-authorized command handles them.

The production `HomeAgentRuntime` is the unique owner of the Proposal store,
Artifact Registry, and Authority Candidate Registry. It mounts borrowed
read-only/review services, constructs one root-private pipeline and durable job
runner, and drains them before disposing Cordis and closing the three stores.
The authority-candidate database has its own
`authority-candidates.sqlite` path under `HOB_DATA_DIR`; it is not co-located
with Artifact records and is never forwarded to the Agent or a bridge.

## Cordis, Agent, bridge, and Inbox boundaries

The queue, preparation worker, `ArtifactRegistry`,
`AuthorityCandidateRegistry`, and their writable ports are not Cordis
`Context` services. No `Context` augmentation such as
`homeArtifactRegistry`, `homePreparationPipeline`, or
`homePreparationJobs` is permitted. The production root constructs the private
worker and passes narrow dependencies to it, while no child service can
discover a writable registry or invoke preparation by name.

The Agent receives only the existing governed proposal tool and bounded
read-only home context. It cannot enqueue, claim, retry, compile, dry-run,
inspect Registry rows directly, choose an authority candidate, or obtain a
job token. The exact admitted Proposal source is re-read by Hub code, never
supplied as a model-controlled callback payload.

The bridge adapter remains a neutral observation provider. The preparation
worker consumes typed HomeWorld snapshots, evidence, and foreign-rule
metadata; it receives no bridge adapter instance, control method, credential,
native identity, or remote route. Preparation has no device-write port at all.

`HomeArtifactService` remains the only read projection into the review layer.
It must query by the exact `proposalId + proposalRevision`/`ArtifactRef` and
return bounded neutral metadata. It exposes job status, ArtifactRef,
assessment/result identities, closed reasons, neutral diff/conflict, and the
dry-run fact `writesPerformed: false`; it must not expose writable Registry
objects, provider payloads, raw errors, or a route to the worker.

The Proposal envelope's raw `dryRun` field and the ArtifactReview attestation
are separate facts. The raw field remains `not_run` as the admission-time
Proposal fact. ArtifactReview reports compile and dry-run status only when its
exact Artifact revision and attestation rows exist; it returns `not_run` when
that exact review does not exist.

The Inbox receives a read-only preparation projection. It receives no worker,
bridge, Agent, authority resolver, compiler, dry-run producer, queue writer, or
Registry mutation handle. Review controls remain governed proposal operations.
Reading preparation state after a process restart causes no pipeline work.

### Inbox status and explicit retry boundary

The Proposal review projection exposes one exact preparation summary for
`proposalId + proposalRevision`: `status`, `attempt`, optimistic `version`, and
the closed `stage + error code` when failed, plus bounded created/updated time.
It does not expose `jobId`, the job idempotency key, arbitrary error text, or queue enumeration.
This read projection lets a household understand persisted state without
causing work.

Retry is different from status. `HomeAgentRuntime` injects a narrow root-owned
retry port directly into the Inbox composition. It is not a Cordis queue
service. The command contains only the exact Proposal id/revision and
expected preparation version. The root resolves the private job, performs the
existing failed-to-queued optimistic transition, and wakes that exact queued
version only after the durable transition returns. A wake failure does not
roll back or misreport the committed retry. HTTP delivery requires the same
authentication, exact same-origin check, bounded form parsing, and conflict
handling as Proposal review. No retry path accepts a stage, error, job id,
ArtifactRef, route, provider payload, or execution input.

## Dry-run and no-write invariant

Every `NeutralDryRunAttestation`—`passed`, `failed`, or `unavailable`—must
contain the literal boolean `writesPerformed: false`. The Inbox projection
also includes `writesPerformed: false` for `not_run`, so absence of a result is
not mistaken for an applied or successful simulation.

The dry-run path is pure and repeatable. It reads only Hub-owned neutral world
cuts, journal evidence, foreign-rule metadata, assessments, and compiler
inputs. It does not invoke:

- a bridge `control` or remote events-write path;
- an action executor, approval-ticket claim, or artifact host;
- credential resolution or provider/network APIs; or
- any device, automation-installation, enablement, or rollback operation.

Local SQLite writes to the job store or Artifact Registry are persistence
writes, not device writes. A dry-run result with `writesPerformed: true`, an
unknown write marker, or an unrecognized payload is malformed and is rejected
before persistence. No job status can imply that a device action occurred.

## Acceptance gates

Focused tests and crash/concurrency tests must prove:

- admission of one exact automation Proposal revision creates one durable
  queued job and performs zero Artifact Registry, compiler, dry-run, bridge,
  credential, or device writes;
- a Proposal remains pending/preparing until the exact Artifact, evidence,
  authority, risk, compile, and dry-run stages succeed; only its promoted
  `ready` revision accepts the household decision;
- the worker invokes the six stages in the fixed order and every produced row
  binds to the exact ArtifactRef and dependency identities;
- a stage failure leaves prior immutable rows and the admitted Proposal
  untouched, records only a bounded error, and never invokes rollback;
- duplicate enqueue and duplicate retry requests are idempotent, concurrent
  claims produce at most one running attempt, and the finite attempt limit is
  enforced;
- restart performs no automatic replay or claim, while an explicit retry can
  safely complete a partial run without duplicate Registry rows or audit;
- no writable pipeline/Registry object appears in Cordis Context, Agent
  output, Inbox mutation routes, or bridge adapter inputs;
- all dry-run statuses, including failed and unavailable, carry
  `writesPerformed: false`, and spies observe no device/remote write path; and
- the raw Proposal `dryRun:not_run` value remains distinct from the exact
  ArtifactReview compile/dry-run attestation; and
- Inbox inspection is read-only for jobs and Artifact results and starts no
  preparation work.

## Non-goals

This decision does not introduce a custom automation runtime, a second
Artifact schema, a generic job framework, a vector database, a new plugin or
Skill format, an approval ticket, an executor, persistent automation
installation, rollback execution, or a device-control API. Any future remote
write must first extend the governed action-plane decision with an exact
approval ticket, policy gate, idempotency, postcondition verification,
`indeterminate` handling, and a separate no-automatic-retry proof.
