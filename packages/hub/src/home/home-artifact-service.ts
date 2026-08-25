import { Context, Service } from "@deepseek-ai/cordis";

import {
  ArtifactRegistry,
  type ArtifactAssessmentEntry,
  type ArtifactAssessmentListQuery,
  type ArtifactAssessmentLookup,
  type ArtifactRegistryAudit,
  type ArtifactRegistryAuditQuery,
  type ArtifactRegistryEntry,
  type ArtifactRegistryListQuery,
  type ArtifactRegistryOptions,
} from "../artifact/artifact-registry.js";
import type {
  ArtifactCompileAttestation,
  NeutralDryRunAttestation,
} from "../artifact/artifact-compiler-contract.js";
import {
  parseHistoryReplayResult,
  type HistoryReplayResult,
} from "../artifact/artifact-history-replay-attestation.js";
import type { ArtifactRef } from "../artifact/neutral-artifact.js";

declare module "@deepseek-ai/cordis" {
  interface Context {
    homeArtifacts: HomeArtifactService;
  }
}

export interface HomeArtifactRegistryReader {
  readonly getRevision: ArtifactRegistry["getRevision"];
  readonly list: ArtifactRegistry["list"];
  readonly audit: ArtifactRegistry["audit"];
  readonly listAttestations: ArtifactRegistry["listAttestations"];
  readonly latestAttestation: ArtifactRegistry["latestAttestation"];
  readonly currentBySourceProposal: ArtifactRegistry["currentBySourceProposal"];
  readonly latestResult: ArtifactRegistry["latestResult"];
}

export type HomeArtifactServiceOptions = ArtifactRegistryOptions | {
  /** Hub-root-owned read port. The service never closes or widens it. */
  readonly registry: HomeArtifactRegistryReader;
};

export interface HomeArtifactCapabilities {
  readonly schemaVersion: "1";
  readonly lifecycleStates: readonly ["draft", "superseded"];
  readonly canCompile: false;
  readonly canSimulate: false;
  readonly canExecute: false;
}

export interface HomeArtifactDiagnostics extends HomeArtifactCapabilities {
  readonly status: "ready";
  readonly hasRecords: boolean;
}

export interface HomeArtifactReviewEvidence {
  readonly watermarks: readonly ArtifactCompileAttestation["usedWatermarks"][number][];
}

export type HomeArtifactReviewCompile =
  | { readonly status: "not_run" }
  | Pick<
      ArtifactCompileAttestation,
      "status"
      | "resultId"
      | "inputIdentity"
      | "compiler"
      | "usedWatermarks"
      | "diff"
      | "conflicts"
      | "blockingReasons"
      | "actionAuthorityBindings"
    >;

export type HomeArtifactReviewDryRun =
  | {
      readonly status: "not_run";
      readonly writesPerformed: false;
    }
  | Pick<NeutralDryRunAttestation, "status" | "resultId" | "inputIdentity" | "compileAttestationId" | "compileInputIdentity" | "compiler" | "checkedWatermarks" | "diff" | "conflicts" | "actionAuthorityBindings" | "writesPerformed" | "summary">;

export interface HomeArtifactReviewHistoryReplay {
  readonly status: HistoryReplayResult["status"];
  readonly coverage: HistoryReplayResult["coverage"];
  readonly truncated: boolean;
  readonly counts: HistoryReplayResult["counts"];
  readonly reasons: readonly HistoryReplayResult["reasons"][number][];
  readonly writesPerformed: false;
  readonly evaluator: HistoryReplayResult["evaluator"];
  readonly resultId: string;
  readonly inputIdentity: string;
}

/**
 * Bounded, neutral review output for one exact source proposal revision.
 * Artifact content, compiler plan, and all ecosystem/provider details stay in
 * the Hub-owned registry and never cross this facade.
 */
export interface HomeArtifactReviewSnapshot {
  readonly artifact: ArtifactRef;
  readonly proposal: {
    readonly id: string;
    readonly revision: number;
  };
  readonly evidence: HomeArtifactReviewEvidence | undefined;
  readonly compile: HomeArtifactReviewCompile;
  readonly dryRun: HomeArtifactReviewDryRun;
  readonly historyReplay?: HomeArtifactReviewHistoryReplay;
  readonly writesPerformed: false;
}

const CAPABILITIES: HomeArtifactCapabilities = Object.freeze({
  schemaVersion: "1",
  lifecycleStates: Object.freeze(["draft", "superseded"] as const),
  canCompile: false,
  canSimulate: false,
  canExecute: false,
});

/**
 * Production read boundary for M3b artifact records.
 *
 * Registry mutation remains an internal future compiler/policy concern. This
 * service deliberately gives the Agent and review surface no create, compile,
 * simulation, approval, bridge, or execution method.
 */
export class HomeArtifactService extends Service {
  private readonly registry: HomeArtifactRegistryReader;
  private readonly ownedRegistry: ArtifactRegistry | undefined;

  constructor(ctx: Context, options: HomeArtifactServiceOptions) {
    super(ctx, "homeArtifacts");
    if (isBorrowedRegistryOptions(options)) {
      this.registry = options.registry;
      this.ownedRegistry = undefined;
    } else {
      this.ownedRegistry = new ArtifactRegistry(options);
      this.registry = this.ownedRegistry;
    }
  }

  protected async [Service.init](): Promise<void> {
    if (this.ownedRegistry !== undefined) {
      this.ctx.effect(() => () => this.ownedRegistry?.close(), "home-artifacts.close");
    }
  }

  capabilities(): HomeArtifactCapabilities {
    return CAPABILITIES;
  }

  /** Metadata-only projection; artifact titles, behavior and household values never cross it. */
  diagnostics(): HomeArtifactDiagnostics {
    return Object.freeze({
      status: "ready",
      ...CAPABILITIES,
      hasRecords: this.registry.list({ limit: 1 }).length > 0,
    });
  }

  getRevision(artifactId: string, revision: number): ArtifactRegistryEntry | undefined {
    return this.registry.getRevision(artifactId, revision);
  }

  list(query?: ArtifactRegistryListQuery): readonly ArtifactRegistryEntry[] {
    return this.registry.list(query);
  }

  audit(query?: ArtifactRegistryAuditQuery): readonly ArtifactRegistryAudit[] {
    return this.registry.audit(query);
  }

  listAttestations(query?: ArtifactAssessmentListQuery): readonly ArtifactAssessmentEntry[] {
    return this.registry.listAttestations(query);
  }

  latestAttestation(query: ArtifactAssessmentLookup): ArtifactAssessmentEntry | undefined {
    return this.registry.latestAttestation(query);
  }

  /**
   * Returns only the current draft artifact sourced by this exact proposal
   * revision. The Registry performs the narrow source lookup, proves
   * uniqueness, and revalidates the returned lifecycle row before projection.
   */
  reviewForProposal(proposalId: string, proposalRevision: number): HomeArtifactReviewSnapshot | undefined {
    const entry = this.registry.currentBySourceProposal({ proposalId, proposalRevision });
    if (entry === undefined) return undefined;
    if (entry.artifact.sourceProposal.proposalId !== proposalId
      || entry.artifact.sourceProposal.proposalRevision !== proposalRevision) return undefined;

    const artifact = {
      artifactId: entry.artifact.artifactId,
      revision: entry.artifact.revision,
      contentHash: entry.artifact.contentHash,
    } satisfies ArtifactRef;
    const compileEntry = this.registry.latestResult({
      kind: "compile-attestation",
      artifact,
    });
    const dryRunEntry = this.registry.latestResult({
      kind: "dry-run-attestation",
      artifact,
    });
    const compile = compileEntry?.kind === "compile-attestation"
      && compileEntry.result.kind === "compile-attestation"
      ? compileEntry.result
      : undefined;
    const dryRun = dryRunEntry?.kind === "dry-run-attestation"
      && dryRunEntry.result.kind === "dry-run-attestation"
      ? dryRunEntry.result
      : undefined;
    const evidenceEntry = this.registry.latestAttestation({
      kind: "evidence-attestation",
      artifact,
    });
    // A dry-run row cannot stand alone: the projection is only meaningful
    // when it is bound to the exact latest compile row.
    const boundDryRun = compile !== undefined
      && dryRun !== undefined
      && isDryRunBoundToCompile(dryRun, compile)
      ? dryRun
      : undefined;
    const watermarks = compile?.usedWatermarks
      ?? boundDryRun?.checkedWatermarks
      ?? (evidenceEntry?.assessment.kind === "evidence-attestation" ? evidenceEntry.assessment.watermarks : undefined);
    const projectedDryRun: HomeArtifactReviewDryRun = compile !== undefined && boundDryRun !== undefined
      ? projectDryRun(boundDryRun)
      : { status: "not_run", writesPerformed: false };
    const historyReplay = readHistoryReplay(
      this.registry,
      artifact,
      entry.artifact.sourceProposal,
      compile,
      boundDryRun,
    );

    return freezeDeep({
      artifact,
      proposal: {
        id: entry.artifact.sourceProposal.proposalId,
        revision: entry.artifact.sourceProposal.proposalRevision,
      },
      evidence: watermarks === undefined ? undefined : { watermarks },
      compile: compile === undefined ? { status: "not_run" as const } : projectCompile(compile),
      dryRun: projectedDryRun,
      ...(historyReplay === undefined ? {} : { historyReplay }),
      writesPerformed: false as const,
    });
  }
}

function isBorrowedRegistryOptions(
  options: HomeArtifactServiceOptions,
): options is { readonly registry: HomeArtifactRegistryReader } {
  return "registry" in options;
}

function projectCompile(result: ArtifactCompileAttestation): HomeArtifactReviewCompile {
  return {
    status: result.status,
    resultId: result.resultId,
    inputIdentity: result.inputIdentity,
    compiler: result.compiler,
    usedWatermarks: result.usedWatermarks,
    diff: result.diff,
    conflicts: result.conflicts,
    blockingReasons: result.blockingReasons,
    actionAuthorityBindings: result.actionAuthorityBindings,
  };
}

function projectDryRun(result: NeutralDryRunAttestation): HomeArtifactReviewDryRun {
  return {
    status: result.status,
    resultId: result.resultId,
    inputIdentity: result.inputIdentity,
    compileAttestationId: result.compileAttestationId,
    compileInputIdentity: result.compileInputIdentity,
    compiler: result.compiler,
    checkedWatermarks: result.checkedWatermarks,
    diff: result.diff,
    conflicts: result.conflicts,
    actionAuthorityBindings: result.actionAuthorityBindings,
    writesPerformed: false,
    summary: result.summary,
  };
}

function isDryRunBoundToCompile(
  dryRun: NeutralDryRunAttestation,
  compile: ArtifactCompileAttestation,
): boolean {
  return sameArtifactRef(dryRun.artifact, compile.artifact)
    && dryRun.compileAttestationId === compile.resultId
    && dryRun.compileInputIdentity === compile.inputIdentity
    && dryRun.evidenceAttestationId === compile.evidenceAttestationId
    && dryRun.evidenceInputIdentity === compile.evidenceInputIdentity
    && dryRun.riskAssessmentId === compile.riskAssessmentId
    && dryRun.riskInputIdentity === compile.riskInputIdentity
    && dryRun.authorityAssessmentId === compile.authorityAssessmentId
    && dryRun.authorityInputIdentity === compile.authorityInputIdentity
    && dryRun.worldCutIdentity === compile.worldCutIdentity
    && dryRun.foreignCatalogIdentity === compile.foreignCatalogIdentity
    && JSON.stringify(dryRun.compiler) === JSON.stringify(compile.compiler)
    && JSON.stringify(dryRun.checkedWatermarks) === JSON.stringify(compile.usedWatermarks)
    && JSON.stringify(dryRun.actionAuthorityBindings) === JSON.stringify(compile.actionAuthorityBindings)
    && JSON.stringify(dryRun.diff) === JSON.stringify(compile.diff)
    && JSON.stringify(dryRun.conflicts) === JSON.stringify(compile.conflicts);
}

function readHistoryReplay(
  registry: HomeArtifactRegistryReader,
  artifact: ArtifactRef,
  sourceProposal: ArtifactRegistryEntry["artifact"]["sourceProposal"],
  compile: ArtifactCompileAttestation | undefined,
  dryRun: NeutralDryRunAttestation | undefined,
): HomeArtifactReviewHistoryReplay | undefined {
  if (compile === undefined || dryRun === undefined
    || !sameArtifactRef(compile.artifact, artifact)
    || !sameArtifactRef(dryRun.artifact, artifact)) return undefined;

  let entry: ArtifactAssessmentEntry | undefined;
  try {
    entry = registry.latestAttestation({
      kind: "history-replay-attestation",
      artifact,
    });
  } catch {
    return undefined;
  }
  if (!isPlainObject(entry) || !isPlainObject(entry.assessment)
    || !isPlainObject(entry.artifact)
    || entry.kind !== "history-replay-attestation"
    || !sameArtifactRef(entry.artifact as ArtifactRef, artifact)
    || entry.inputIdentity !== entry.assessment.inputIdentity
    || entry.assessment.kind !== "history-replay-attestation") return undefined;

  let result: HistoryReplayResult;
  try {
    result = parseHistoryReplayResult(entry.assessment);
  } catch {
    return undefined;
  }
  if (!sameArtifactRef(result.artifact, artifact)
    || result.proposal.id !== sourceProposal.proposalId
    || result.proposal.revision !== sourceProposal.proposalRevision
    || result.compile.resultId !== compile.resultId
    || result.compile.inputIdentity !== compile.inputIdentity
    || result.dryRun.resultId !== dryRun.resultId
    || result.dryRun.inputIdentity !== dryRun.inputIdentity
    || result.resultId !== entry.recordId
    || result.inputIdentity !== entry.inputIdentity) return undefined;

  return {
    status: result.status,
    coverage: result.coverage,
    truncated: result.truncated,
    counts: result.counts,
    reasons: result.reasons,
    writesPerformed: false,
    evaluator: result.evaluator,
    resultId: result.resultId,
    inputIdentity: result.inputIdentity,
  };
}

function sameArtifactRef(left: ArtifactRef, right: ArtifactRef): boolean {
  return left.artifactId === right.artifactId
    && left.revision === right.revision
    && left.contentHash === right.contentHash;
}

function freezeDeep<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
