# Approved-proposal preparation pipeline

Status: accepted architecture decision for the next non-applying Hub slice.
Implementation is still gated by the existing Artifact, assessment, compiler,
and read-only Inbox contracts.

## Decision

Approving a qualifying automation Proposal does exactly one new thing: it
durably enqueues one Hub-private preparation job for that exact approved
Proposal revision. Approval does not synchronously create an Artifact, collect
fresh evidence, resolve authority, assess risk, compile, or run a simulation.
It also does not install, enable, execute, or roll back anything.

A Hub-private background worker may execute the job in this fixed order:

```text
approved Proposal revision
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

This decision extends the review-only boundary described by
[`proposal-review-loop.md`](proposal-review-loop.md),
[`artifact-proposal-candidate.md`](artifact-proposal-candidate.md), and
[`neutral-artifact-contract.md`](neutral-artifact-contract.md). It does not
turn Proposal approval into Artifact approval or execution approval.

## Approval and enqueue boundary

Only an approved `automation-draft` with a valid neutral `artifactCandidate`
qualifies for this preparation job. Approving an insight, identity proposal,
or another non-automation kind remains review metadata and does not create an
Artifact job.

The Hub review boundary must:

1. validate the optimistic Proposal revision and the existing terminal review
   rules;
2. append the human approval and its audit event;
3. append exactly one job keyed by the approved `(proposalId,
   proposalRevision)`; and
4. return the approved Proposal review result, not a compiler or dry-run
   result.

The review and enqueue writes share one Hub-owned durable transaction boundary
so a successful approval cannot be observed without its durable job. If that
boundary cannot commit, the approval fails closed before it becomes visible;
the Hub does not commit an approval and later pretend that an in-memory queue
is sufficient. This is a local review/job durability guarantee, not a claim of
one transaction across the Proposal database and Artifact Registry.

After the approval and enqueue commit, the Proposal is not rolled back when a
job stage fails. Its `status` remains the terminal `approved` state and its
`applicationStatus` remains `not_available`. A failed preparation attempt does
not reject, expire, or rewrite the Proposal; it does not delete, supersede, or
compensate an already persisted Artifact or assessment row. The rollback field
inside the reviewed neutral Artifact candidate is intent for a future action
plane and is never executed by preparation.

Repeated delivery of the approval request is handled by the existing Proposal
revision/terminal checks and the same enqueue identity. It must return the
existing durable result or a bounded conflict; it must never create a second
job for the same approved revision.

## Durable job contract

The job queue is Hub-private durable state. It stores references and bounded
lifecycle metadata, not a copy of the Proposal, model output, raw bridge data,
native identifiers, credentials, or arbitrary exception text. The approved
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

The queue may be physically co-located with the Proposal store to provide the
approval/enqueue transaction. It is not an Artifact Registry and is not a
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
| `artifact` | Re-read `withApprovedProposalAtRevision`; copy the exact reviewed title, summary, and candidate; let Hub generate the Artifact identity | Artifact revision 1 / `draft` | No candidate reinterpretation, bridge call, or device write |
| `evidence` | Re-read the exact Artifact and approved Proposal; query a fresh bounded HomeWorld/evidence cut | Immutable `evidence-attestation` | No Agent-authored watermark or raw event copy |
| `authority` | Build a fresh opaque Hub-private binding input; resolve exactly one candidate per device-action capability through `AuthorityCandidateRegistry` | Immutable `authority-assessment` | No route, native ID, credential, or fallback authority in neutral output |
| `risk` | Re-check exact evidence and authority identities; run the fixed Hub policy and bounded conflict source | Immutable `risk-assessment` | No model risk label or missing-conflict-as-zero inference |
| `compile` | Re-read exact dependencies, capture the current conflict cut, create a stable neutral world cut, and run the pure compiler | Immutable `compile-attestation` | No provider payload, action ticket, or remote call |
| `dry-run` | Run the pure neutral simulator against that compile result | Immutable `dry-run-attestation` | No bridge control/events write, credential resolve, executor, or artifact host |

The causal production order is fixed even though a compiler coordinator may
read already persisted dependencies in its own validation order. In
particular, risk cannot be produced without the exact evidence and authority
rows, and compile cannot run without all three assessments and its fresh
read-only conflict/world inputs. Missing, stale, malformed, or mismatched
inputs fail the job at the owning stage.

`ArtifactRegistry` is the sole owner of Artifact revision, evidence,
authority, risk, compile, and dry-run records. The preparation worker may
compose calls to that Registry; it may not maintain a shadow Artifact map or
let Proposal, Agent, Inbox, plugin, authority configuration, or bridge code
write those records. `AuthorityCandidateRegistry` remains a separate
Hub-private opaque candidate store as defined by
[`authority-candidate-registry.md`](authority-candidate-registry.md); its
candidate rows never become Artifact ownership or an execution route.

## Idempotency, retry, and restart

There are two distinct idempotency layers:

- **Enqueue identity:** the Hub derives a stable key from
  `approved-proposal-preparation-v1`, `proposalId`, and the exact approved
  Proposal revision. A replay returns the existing job and does not append a
  second queue row.
- **Stage identity:** Artifact Registry writes use the existing deterministic
  keys for the exact ArtifactRef and assessment/result input identities. A
  retry may re-read fresh HomeWorld inputs and therefore produce a new
  immutable assessment/result identity, but replaying the same input returns
  the original row without duplicate audit.

Retry is an explicit Hub-private command, never an automatic timer or
backoff. It requires the expected job state/version and a deterministic retry
identity derived from the job and next attempt. A successful duplicate retry
request returns the existing transition. A retry can move a failed attempt
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
may wake that process's explicitly mounted worker; that event is not startup
replay. Jobs left `queued` or `running` by shutdown remain so until an
explicit, operator-authorized command handles them.

## Cordis, Agent, bridge, and Inbox boundaries

The queue, preparation worker, `ArtifactRegistry`,
`AuthorityCandidateRegistry`, and their writable ports are not Cordis
`Context` services. No `Context` augmentation such as
`homeArtifactRegistry`, `homePreparationPipeline`, or
`homePreparationJobs` is permitted. The production root may construct the
private worker and pass narrow dependencies to it, but no child service can
discover a writable registry or invoke preparation by name.

The Agent receives only the existing governed proposal tool and bounded
read-only home context. It cannot enqueue, claim, retry, compile, dry-run,
inspect Registry rows directly, choose an authority candidate, or obtain a
job token. An approved Proposal source is re-read by Hub code, never supplied
as a model-controlled callback payload.

The bridge adapter remains a neutral observation provider. The preparation
worker consumes typed HomeWorld snapshots, evidence, and foreign-rule
metadata; it receives no bridge adapter instance, control method, credential,
native identity, or remote route. Preparation has no device-write port at all.

`HomeArtifactService` remains the only read projection into the review layer.
It must query by the exact `proposalId + proposalRevision`/`ArtifactRef` and
return bounded neutral metadata. It may expose job status, ArtifactRef,
assessment/result identities, closed reasons, neutral diff/conflict, and the
dry-run fact `writesPerformed: false`; it must not expose writable Registry
objects, provider payloads, raw errors, or a route to the worker.

The standalone Inbox composition described in
[`standalone-inbox.md`](standalone-inbox.md) is read-only for this pipeline:
it does not mount the worker, bridge, Agent, authority resolver, compiler,
dry-run producer, queue writer, or Registry mutation handle. It cannot enqueue,
retry, compile, simulate, install, enable, execute, or roll back. Any
pre-existing proposal review controls remain governed review operations only;
they do not turn the standalone process into a preparation worker. The
preparation projection is therefore safe to inspect after a process restart
without causing new home reads or pipeline work.

## Dry-run and no-write invariant

Every `NeutralDryRunAttestation`—`passed`, `failed`, or `unavailable`—must
contain the literal boolean `writesPerformed: false`. The Inbox projection
also includes `writesPerformed: false` for `not_run`, so absence of a result is
not mistaken for an applied or successful simulation.

The dry-run path is pure and repeatable. It may read only Hub-owned neutral
world cuts, journal evidence, foreign-rule metadata, assessments, and compiler
inputs. It must not invoke:

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

- approval of one exact automation Proposal revision creates one durable
  queued job and performs zero Artifact Registry, compiler, dry-run, bridge,
  credential, or device writes;
- the worker invokes the six stages in the fixed order and every produced row
  binds to the exact ArtifactRef and dependency identities;
- a stage failure leaves prior immutable rows and the approved Proposal
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
- standalone Inbox inspection is read-only for jobs and Artifact results and
  does not reconnect the bridge, start DSH, or run preparation.

## Non-goals

This decision does not introduce a custom automation runtime, a second
Artifact schema, a generic job framework, a vector database, a new plugin or
Skill format, an approval ticket, an executor, persistent automation
installation, rollback execution, or a device-control API. Any future remote
write must first extend the governed action-plane decision with an exact
approval ticket, policy gate, idempotency, postcondition verification,
`indeterminate` handling, and a separate no-automatic-retry proof.
