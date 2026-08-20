import {
  ArtifactCompilationCoordinatorError,
  type ArtifactCompilationCoordinatorStage,
} from "./artifact-compilation-coordinator.js";
import type {
  ArtifactCompilationCoordinator,
  ArtifactCompilationReceipt,
} from "./artifact-compilation-coordinator.js";
import {
  ArtifactMutationCoordinatorError,
  type ArtifactMutationCoordinatorStage,
} from "./artifact-mutation-coordinator.js";
import type {
  ArtifactMutationCoordinator,
  ArtifactMutationProposalCommand,
  ArtifactMutationReceipt,
} from "./artifact-mutation-coordinator.js";

export interface ArtifactPreparationCoordinatorOptions {
  readonly mutation: Pick<ArtifactMutationCoordinator, "fromApprovedProposal">;
  readonly compilation: Pick<ArtifactCompilationCoordinator, "compile">;
}

export interface ArtifactPreparationPipelinePort {
  readonly run: (command: ArtifactMutationProposalCommand) => Promise<ArtifactPreparationReceipt>;
}

export type ArtifactPreparationServiceOptions = ArtifactPreparationCoordinatorOptions | {
  readonly pipeline: ArtifactPreparationPipelinePort;
};

export interface ArtifactPreparationReceipt {
  readonly mutation: ArtifactMutationReceipt;
  readonly compilation: ArtifactCompilationReceipt;
}

export type ArtifactPreparationServiceStage =
  | ArtifactMutationCoordinatorStage
  | ArtifactCompilationCoordinatorStage
  | "mutation"
  | "lifecycle";
export type ArtifactPreparationServiceFailureCode = "failed" | "stopped" | "malformed_result";

export class ArtifactPreparationServiceError extends Error {
  constructor(
    readonly stage: ArtifactPreparationServiceStage,
    readonly code: ArtifactPreparationServiceFailureCode,
  ) {
    super(`Artifact preparation ${stage} stage ${code}`);
    this.name = "ArtifactPreparationServiceError";
  }
}

/**
 * Hub-root-private sequencing facade. It is deliberately not a Cordis Service
 * and exposes no registry, bridge, credential, route, or execution handle.
 */
export class ArtifactPreparationService {
  private readonly mutation: ArtifactPreparationCoordinatorOptions["mutation"] | undefined;
  private readonly compilation: ArtifactPreparationCoordinatorOptions["compilation"] | undefined;
  private readonly executePreparation: ArtifactPreparationPipelinePort["run"] | undefined;
  private readonly inFlight = new Map<string, Promise<ArtifactPreparationReceipt>>();
  private stopping = false;
  private stopTask: Promise<void> | undefined;

  constructor(options: ArtifactPreparationServiceOptions) {
    if (!isOptions(options)) throw new TypeError("Artifact preparation options are invalid");
    if ("pipeline" in options) {
      this.mutation = undefined;
      this.compilation = undefined;
      this.executePreparation = options.pipeline.run.bind(options.pipeline);
    } else {
      this.mutation = options.mutation;
      this.compilation = options.compilation;
      this.executePreparation = undefined;
    }
  }

  prepare(command: ArtifactMutationProposalCommand): Promise<ArtifactPreparationReceipt> {
    if (this.stopping) {
      return Promise.reject(new ArtifactPreparationServiceError("lifecycle", "stopped"));
    }
    const parsed = parseCommand(command);
    const key = `${parsed.proposalId.length}:${parsed.proposalId}:${parsed.proposalRevision}`;
    const current = this.inFlight.get(key);
    if (current !== undefined) return current;

    const task = this.run(parsed);
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

  private async run(command: ArtifactMutationProposalCommand): Promise<ArtifactPreparationReceipt> {
    if (this.executePreparation !== undefined) {
      const receipt = await this.executePreparation(command);
      if (!isReceiptBound(receipt)) {
        throw new ArtifactPreparationServiceError("compile", "malformed_result");
      }
      return freezeDeep(receipt);
    }
    let mutation: ArtifactMutationReceipt;
    try {
      mutation = this.mutation!.fromApprovedProposal(command);
    } catch (error) {
      if (error instanceof ArtifactMutationCoordinatorError) {
        throw new ArtifactPreparationServiceError(error.stage, "failed");
      }
      throw new ArtifactPreparationServiceError("mutation", "failed");
    }

    let compilation: ArtifactCompilationReceipt;
    try {
      compilation = await this.compilation!.compile(mutation.artifact);
    } catch (error) {
      if (error instanceof ArtifactCompilationCoordinatorError) {
        throw new ArtifactPreparationServiceError(error.stage, "failed");
      }
      throw new ArtifactPreparationServiceError("compile", "failed");
    }
    if (!sameArtifact(mutation, compilation) || compilation.dryRun.writesPerformed !== false) {
      throw new ArtifactPreparationServiceError("compile", "malformed_result");
    }
    return freezeDeep({ mutation, compilation });
  }
}

function isOptions(value: unknown): value is ArtifactPreparationServiceOptions {
  if (!isPlainObject(value)) return false;
  if (hasExactKeys(value, ["pipeline"])) return hasMethod(value.pipeline, "run");
  if (!hasExactKeys(value, ["mutation", "compilation"])) return false;
  return hasMethod(value.mutation, "fromApprovedProposal") && hasMethod(value.compilation, "compile");
}

function parseCommand(value: unknown): ArtifactMutationProposalCommand {
  if (!isPlainObject(value) || !hasExactKeys(value, ["proposalId", "proposalRevision"])) {
    throw new TypeError("Artifact preparation command is invalid");
  }
  if (typeof value.proposalId !== "string"
    || value.proposalId.length === 0
    || value.proposalId.trim() !== value.proposalId
    || Buffer.byteLength(value.proposalId, "utf8") > 200
    || typeof value.proposalRevision !== "number"
    || !Number.isSafeInteger(value.proposalRevision)
    || value.proposalRevision < 1) {
    throw new TypeError("Artifact preparation command is invalid");
  }
  return Object.freeze({
    proposalId: value.proposalId,
    proposalRevision: value.proposalRevision,
  });
}

function sameArtifact(
  mutation: ArtifactMutationReceipt,
  compilation: ArtifactCompilationReceipt,
): boolean {
  return mutation.artifact.artifactId === compilation.artifact.artifactId
    && mutation.artifact.revision === compilation.artifact.revision
    && mutation.artifact.contentHash === compilation.artifact.contentHash;
}

function isReceiptBound(value: unknown): value is ArtifactPreparationReceipt {
  if (!isPlainObject(value)
    || !hasExactKeys(value, ["mutation", "compilation"])
    || !isPlainObject(value.mutation)
    || !isPlainObject(value.compilation)) return false;
  const mutation = value.mutation as unknown as ArtifactMutationReceipt;
  const compilation = value.compilation as unknown as ArtifactCompilationReceipt;
  return isPlainObject(mutation.artifact)
    && isPlainObject(compilation.artifact)
    && isPlainObject(compilation.dryRun)
    && compilation.dryRun.writesPerformed === false
    && sameArtifact(mutation, compilation);
}

function hasMethod(value: unknown, name: string): boolean {
  return (typeof value === "object" && value !== null) || typeof value === "function"
    ? typeof (value as Record<string, unknown>)[name] === "function"
    : false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return keys.length === wanted.length && keys.every((key, index) => key === wanted[index]);
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freezeDeep(item);
    Object.freeze(value);
  }
  return value;
}
