export const ARTIFACT_PREPARATION_JOB_STAGES = [
  "artifact",
  "evidence",
  "authority",
  "risk",
  "compile",
  "dry-run",
  "history-replay",
] as const;
export type ArtifactPreparationJobStage = typeof ARTIFACT_PREPARATION_JOB_STAGES[number];

export const ARTIFACT_PREPARATION_JOB_ERROR_CODES = [
  "not_found",
  "unavailable",
  "malformed_dependency",
  "policy_blocked",
  "persistence_failed",
  "attempt_exhausted",
] as const;
export type ArtifactPreparationJobErrorCode = typeof ARTIFACT_PREPARATION_JOB_ERROR_CODES[number];
export type ArtifactPreparationJobStatus = "queued" | "running" | "succeeded" | "failed";

export interface ArtifactPreparationJob {
  readonly schemaVersion: "1";
  readonly kind: "approved-proposal-preparation";
  readonly jobId: string;
  readonly proposalId: string;
  readonly proposalRevision: number;
  readonly idempotencyKey: string;
  readonly status: ArtifactPreparationJobStatus;
  readonly attempt: number;
  readonly version: number;
  readonly stage?: ArtifactPreparationJobStage;
  readonly error?: {
    readonly stage: ArtifactPreparationJobStage;
    readonly code: ArtifactPreparationJobErrorCode;
  };
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ArtifactPreparationJobTransition {
  readonly jobId: string;
  readonly expectedVersion: number;
}

export interface ArtifactPreparationJobFailure extends ArtifactPreparationJobTransition {
  readonly stage: ArtifactPreparationJobStage;
  readonly code: ArtifactPreparationJobErrorCode;
}

export interface ArtifactPreparationJobPort {
  readonly claimPreparationJob: (input: ArtifactPreparationJobTransition) => ArtifactPreparationJob;
  readonly completePreparationJob: (input: ArtifactPreparationJobTransition & {
    /** The immutable receipt refs commit atomically with the success itself. */
    readonly preparedArtifact: {
      readonly artifactId: string;
      readonly revision: number;
      readonly contentHash: string;
      readonly compileResultId: string;
      readonly dryRunResultId: string;
    };
  }) => ArtifactPreparationJob;
  readonly failPreparationJob: (input: ArtifactPreparationJobFailure) => ArtifactPreparationJob;
  /**
   * Promotes the prepared proposal into the household inbox. Optional so
   * borrowed job stores without proposal ownership stay valid; the runner
   * treats a declined promotion (capacity, superseded revision) as deferred,
   * never as a job failure.
   */
  readonly markProposalReady?: (input: {
    readonly proposalId: string;
    readonly expectedRevision?: number;
    readonly actor?: string;
  }) => unknown;
}
