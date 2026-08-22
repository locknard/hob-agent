import {
  ArtifactPreparationServiceError,
  type ArtifactPreparationService,
} from "./artifact-preparation-service.js";
import type {
  ArtifactPreparationJob,
  ArtifactPreparationJobErrorCode,
  ArtifactPreparationJobPort,
  ArtifactPreparationJobStage,
} from "./preparation-job-port.js";

export interface ArtifactPreparationJobRunnerOptions {
  readonly jobs: ArtifactPreparationJobPort;
  readonly preparation: Pick<ArtifactPreparationService, "prepare">;
}

/** Root-private durable-job executor. Construction and start never replay jobs. */
export class ArtifactPreparationJobRunner {
  private readonly jobs: ArtifactPreparationJobPort;
  private readonly preparation: ArtifactPreparationJobRunnerOptions["preparation"];
  private readonly inFlight = new Map<string, Promise<void>>();
  private stopping = false;
  private stopTask: Promise<void> | undefined;

  constructor(options: ArtifactPreparationJobRunnerOptions) {
    this.jobs = options.jobs;
    this.preparation = options.preparation;
  }

  async start(): Promise<void> {
    // Deliberately empty: queued jobs require an explicit wake or retry action.
  }

  run(jobId: string, expectedVersion: number): Promise<void> {
    if (this.stopping) return Promise.reject(new Error("Artifact preparation job runner is stopped"));
    const key = `${jobId.length}:${jobId}:${expectedVersion}`;
    const current = this.inFlight.get(key);
    if (current !== undefined) return current;
    const task = this.execute(jobId, expectedVersion);
    this.inFlight.set(key, task);
    void task.finally(() => {
      if (this.inFlight.get(key) === task) this.inFlight.delete(key);
    }).catch(() => undefined);
    return task;
  }

  stop(): Promise<void> {
    if (this.stopTask !== undefined) return this.stopTask;
    this.stopping = true;
    this.stopTask = Promise.allSettled([...this.inFlight.values()]).then(() => undefined);
    return this.stopTask;
  }

  private async execute(jobId: string, expectedVersion: number): Promise<void> {
    const claimed = this.jobs.claimPreparationJob({ jobId, expectedVersion });
    try {
      const receipt = await this.preparation.prepare({
        proposalId: claimed.proposalId,
        proposalRevision: claimed.proposalRevision,
      });
      this.jobs.completePreparationJob({
        jobId: claimed.jobId,
        expectedVersion: claimed.version,
        preparedArtifact: {
          artifactId: receipt.compilation.artifact.artifactId,
          revision: receipt.compilation.artifact.revision,
          contentHash: receipt.compilation.artifact.contentHash,
          compileResultId: receipt.compilation.compile.resultId,
          dryRunResultId: receipt.compilation.dryRun.resultId,
        },
      });
      try {
        this.jobs.markProposalReady?.({
          proposalId: claimed.proposalId,
          expectedRevision: claimed.proposalRevision,
          actor: "system",
        });
      } catch {
        // The preparation itself is durable; a full inbox or a superseded
        // revision defers promotion to the store's lazy sweep.
      }
    } catch (error) {
      const failure = boundedFailure(error);
      this.failClaimedJob(claimed, failure.stage, failure.code);
      throw error;
    }
  }

  private failClaimedJob(
    claimed: ArtifactPreparationJob,
    stage: ArtifactPreparationJobStage,
    code: ArtifactPreparationJobErrorCode,
  ): void {
    this.jobs.failPreparationJob({
      jobId: claimed.jobId,
      expectedVersion: claimed.version,
      stage,
      code,
    });
  }
}

function boundedFailure(error: unknown): {
  readonly stage: ArtifactPreparationJobStage;
  readonly code: ArtifactPreparationJobErrorCode;
} {
  if (!(error instanceof ArtifactPreparationServiceError)) {
    return { stage: "artifact", code: "unavailable" };
  }
  return {
    stage: boundStage(error.stage),
    code: error.code === "malformed_result" ? "malformed_dependency" : "unavailable",
  };
}

function boundStage(stage: ArtifactPreparationServiceError["stage"]): ArtifactPreparationJobStage {
  switch (stage) {
    case "artifact":
    case "evidence":
    case "authority":
    case "risk":
    case "compile":
    case "dry-run":
      return stage;
    case "dry-run-persist":
      return "dry-run";
    case "capture":
    case "world-cut":
    case "proposal":
    case "compile-input":
    case "compile-persist":
      return "compile";
    case "mutation":
    case "lifecycle":
      return "artifact";
  }
}
