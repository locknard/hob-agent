import {
  parseArtifactAuthorityAssessment,
  parseArtifactEvidenceAttestation,
  parseArtifactRiskAssessment,
  type ArtifactAuthorityAssessment,
  type ArtifactEvidenceAttestation,
  type ArtifactRiskAssessment,
} from "./artifact-assessments.js";
import {
  computeNeutralForeignCatalogIdentity,
  createArtifactCompileInput,
  parseArtifactCompileAttestation,
  parseArtifactCompileInput,
  parseNeutralConflictInput,
  parseNeutralConflictResult,
  parseNeutralDryRunAttestation,
  parseNeutralWorldCut,
  neutralCompilerSchema,
  type ArtifactCompileAttestation,
  type ArtifactCompileInput,
  type NeutralDryRunAttestation,
  type NeutralWorldCut,
} from "./artifact-compiler-contract.js";
import type { NeutralArtifactCompiler } from "./artifact-compiler.js";
import type { NeutralDryRunProducer } from "./artifact-dry-run.js";
import type {
  ArtifactCurrentConflictCapture,
  ArtifactCurrentConflictCapturePort,
  ArtifactCurrentConflictCompileCut,
} from "./artifact-current-conflict-source.js";
import type { ArtifactWorldCutInput } from "./artifact-world-cut-source.js";
import type { ArtifactAssessmentEntry, ArtifactRegistryEntry } from "./artifact-registry.js";
import { artifactRefSchema, parseArtifactRevision, type ArtifactRef, type ArtifactRevision } from "./neutral-artifact.js";

export type ArtifactCompilationProposalStatus = "pending_review" | "approved" | "rejected" | "expired";

/** The exact proposal metadata needed by the compiler. */
export interface ArtifactCompilationProposal {
  readonly id: string;
  readonly revision: number;
  readonly status: ArtifactCompilationProposalStatus;
}

/** Read-only proposal lookup; richer proposal envelopes are structurally compatible. */
export interface ArtifactCompilationProposalPort {
  readonly get: (proposalId: string) => ArtifactCompilationProposal | undefined;
}

/** The registry seam is intentionally local to this coordinator. */
export interface ArtifactCompilationRegistryPort {
  readonly getRevision: (artifactId: string, revision: number) => ArtifactRegistryEntry | undefined;
  readonly latestAttestation: (query: {
    readonly kind: "evidence-attestation" | "risk-assessment" | "authority-assessment";
    readonly artifact: ArtifactRef;
  }) => ArtifactAssessmentEntry | undefined;
  readonly recordCompile: (input: ArtifactCompilationRecordInput<ArtifactCompileAttestation>) => unknown;
  readonly recordDryRun: (input: ArtifactCompilationRecordInput<NeutralDryRunAttestation>) => unknown;
}

export interface ArtifactCompilationRecordInput<T extends ArtifactCompileAttestation | NeutralDryRunAttestation> {
  readonly result: T;
  readonly idempotencyKey: string;
  readonly actor?: string;
}

/** Synchronous, read-only neutral world-cut projection. */
export interface ArtifactCompilationWorldCutPort {
  readonly read: (input: ArtifactWorldCutInput) => NeutralWorldCut;
}

/** Optional object form for callers that keep compiler identity beside the pure function. */
export interface ArtifactCompilationCompilerPort {
  readonly id: string;
  readonly version: string;
  readonly compile: NeutralArtifactCompiler;
}

export interface ArtifactCompilationDryRunPort {
  readonly produce: NeutralDryRunProducer;
}

/** A minimal durable compiler-result row accepted from the registry seam. */
export interface ArtifactCompilationResultEntry<T extends ArtifactCompileAttestation | NeutralDryRunAttestation = ArtifactCompileAttestation | NeutralDryRunAttestation> {
  readonly kind: T["kind"];
  readonly resultId: string;
  readonly artifact: ArtifactRef;
  readonly inputIdentity: string;
  readonly sequence?: number;
  readonly recordedAt?: string;
  readonly result: T;
  readonly audit?: readonly unknown[];
}

export interface ArtifactCompilationCoordinatorOptions {
  readonly registry: ArtifactCompilationRegistryPort;
  /** Existing naming used by Hub proposal ports. Exactly one proposal alias is allowed. */
  readonly proposals?: ArtifactCompilationProposalPort;
  readonly proposal?: ArtifactCompilationProposalPort;
  /** Existing naming used by the evidence-bound current-conflict source. */
  readonly conflict?: ArtifactCurrentConflictCapturePort;
  readonly currentConflict?: ArtifactCurrentConflictCapturePort;
  readonly worldCut: ArtifactCompilationWorldCutPort;
  readonly compiler: ArtifactCompilationCompilerPort;
  readonly dryRun: NeutralDryRunProducer | ArtifactCompilationDryRunPort;
}

export interface ArtifactCompilationReceipt {
  readonly artifact: ArtifactRef;
  readonly compile: {
    readonly resultId: string;
    readonly inputIdentity: string;
    readonly status: ArtifactCompileAttestation["status"];
  };
  readonly dryRun: {
    readonly resultId: string;
    readonly inputIdentity: string;
    readonly status: NeutralDryRunAttestation["status"];
    readonly writesPerformed: false;
  };
}

export type ArtifactCompilationCoordinatorStage =
  | "artifact"
  | "evidence"
  | "risk"
  | "authority"
  | "capture"
  | "world-cut"
  | "proposal"
  | "compile-input"
  | "compile"
  | "dry-run"
  | "compile-persist"
  | "dry-run-persist";

export type ArtifactCompilationCoordinatorFailureCode =
  | "invalid_input"
  | "not_found"
  | "unavailable"
  | "malformed_dependency"
  | "malformed_result"
  | "persistence_failed";

export class ArtifactCompilationCoordinatorError extends Error {
  constructor(
    readonly stage: ArtifactCompilationCoordinatorStage,
    readonly code: ArtifactCompilationCoordinatorFailureCode,
  ) {
    super(`Artifact compilation ${stage} stage failed`);
    this.name = "ArtifactCompilationCoordinatorError";
  }
}

/**
 * Unmounted M3c composition. It owns sequencing and binding checks only;
 * capture, world projection, compiler, dry-run, and Registry writes remain
 * narrow typed seams. No transaction is held over the asynchronous capture.
 */
export class ArtifactCompilationCoordinator {
  private readonly registry: ArtifactCompilationRegistryPort;
  private readonly proposals: ArtifactCompilationProposalPort;
  private readonly conflict: ArtifactCurrentConflictCapturePort;
  private readonly worldCut: ArtifactCompilationWorldCutPort;
  private readonly compiler: NeutralArtifactCompiler;
  private readonly compilerIdentity: ArtifactCompileInput["compiler"];
  private readonly dryRun: NeutralDryRunProducer;

  constructor(options: ArtifactCompilationCoordinatorOptions) {
    assertStrictOptions(options);
    this.registry = options.registry;
    this.proposals = options.proposals ?? options.proposal!;
    this.conflict = options.conflict ?? options.currentConflict!;
    this.worldCut = options.worldCut;
    this.compiler = options.compiler.compile;
    this.compilerIdentity = { id: options.compiler.id, version: options.compiler.version };
    this.dryRun = typeof options.dryRun === "function" ? options.dryRun : options.dryRun.produce;
  }

  /** Compile and dry-run exactly one immutable ArtifactRef. */
  async compile(input: ArtifactRef): Promise<ArtifactCompilationReceipt> {
    assertCoordinatorReceiver(this);
    const artifactRef = parseArtifactRef(input);
    const artifact = this.readExactDraft(artifactRef);
    const evidence = this.readLatestAssessment("evidence-attestation", artifactRef);
    const risk = this.readLatestAssessment("risk-assessment", artifactRef);
    const authority = this.readLatestAssessment("authority-assessment", artifactRef);
    assertRiskDependencies(risk, evidence, authority);

    const capture = await this.capture(artifactRef, evidence);
    const compileCut = this.readCompileCut(capture, risk);
    const worldCut = this.readWorldCut({ artifact: artifactRef, evidence, risk, authority });
    const proposal = this.readExactProposal(artifact.sourceProposal.proposalId, artifact.sourceProposal.proposalRevision);

    const compileInput = this.createCompileInput({
      artifact,
      proposal,
      evidence,
      risk,
      authority,
      currentConflict: compileCut.currentConflict,
      worldCut,
      foreignCatalogIdentity: compileCut.foreignCatalogIdentity,
      foreignRuleChecks: [...compileCut.foreignRuleChecks],
      compiler: this.readCompilerIdentity(),
    });
    const compile = this.runCompiler(compileInput);
    const dryRun = this.runDryRun(compile);

    const compileRow = this.recordCompile(compile);
    const dryRunRow = this.recordDryRun(dryRun);

    return freezeDeep({
      artifact: Object.freeze({ ...artifactRef }),
      compile: Object.freeze({
        resultId: compileRow.result.resultId,
        inputIdentity: compileRow.result.inputIdentity,
        status: compileRow.result.status,
      }),
      dryRun: Object.freeze({
        resultId: dryRunRow.result.resultId,
        inputIdentity: dryRunRow.result.inputIdentity,
        status: dryRunRow.result.status,
        writesPerformed: false as const,
      }),
    });
  }

  private readExactDraft(ref: ArtifactRef): ArtifactRevision {
    let entry: ArtifactRegistryEntry | undefined;
    try {
      entry = this.registry.getRevision(ref.artifactId, ref.revision);
    } catch {
      throw coordinatorError("artifact", "unavailable");
    }
    if (!isPlainObject(entry)
      || entry.status !== "draft"
      || entry.tombstone !== false
      || !isPlainObject(entry.artifact)) {
      throw coordinatorError("artifact", entry === undefined ? "not_found" : "malformed_dependency");
    }
    let artifact: ArtifactRevision;
    try {
      artifact = parseArtifactRevision(entry.artifact);
    } catch {
      throw coordinatorError("artifact", "malformed_dependency");
    }
    if (!sameArtifactRef(artifact, ref)) throw coordinatorError("artifact", "malformed_dependency");
    return artifact;
  }

  private readLatestAssessment(kind: "evidence-attestation", artifact: ArtifactRef): ArtifactEvidenceAttestation;
  private readLatestAssessment(kind: "risk-assessment", artifact: ArtifactRef): ArtifactRiskAssessment;
  private readLatestAssessment(kind: "authority-assessment", artifact: ArtifactRef): ArtifactAuthorityAssessment;
  private readLatestAssessment(
    kind: "evidence-attestation" | "risk-assessment" | "authority-assessment",
    artifact: ArtifactRef,
  ): ArtifactEvidenceAttestation | ArtifactRiskAssessment | ArtifactAuthorityAssessment {
    let row: ArtifactAssessmentEntry | undefined;
    try {
      row = this.registry.latestAttestation({ kind, artifact });
    } catch {
      throw coordinatorError(stageForAssessment(kind), "unavailable");
    }
    if (row === undefined) throw coordinatorError(stageForAssessment(kind), "not_found");
    if (!isPlainObject(row)
      || row.kind !== kind
      || !isExactArtifactRef(row.artifact, artifact)
      || !isPlainObject(row.assessment)) {
      throw coordinatorError(stageForAssessment(kind), "malformed_dependency");
    }
    let assessment: ArtifactEvidenceAttestation | ArtifactRiskAssessment | ArtifactAuthorityAssessment;
    try {
      assessment = kind === "evidence-attestation"
        ? parseArtifactEvidenceAttestation(row.assessment)
        : kind === "risk-assessment"
          ? parseArtifactRiskAssessment(row.assessment)
          : parseArtifactAuthorityAssessment(row.assessment);
    } catch {
      throw coordinatorError(stageForAssessment(kind), "malformed_dependency");
    }
    const recordId = assessment.kind === "evidence-attestation" ? assessment.attestationId : assessment.assessmentId;
    if (!sameArtifactRef(assessment.artifact, artifact)
      || row.recordId !== recordId
      || row.inputIdentity !== assessment.inputIdentity) {
      throw coordinatorError(stageForAssessment(kind), "malformed_dependency");
    }
    return assessment;
  }

  private async capture(artifact: ArtifactRef, evidence: ArtifactEvidenceAttestation): Promise<ArtifactCurrentConflictCapture> {
    let value: unknown;
    try {
      value = await this.conflict.capture({ artifact, evidence });
    } catch {
      throw coordinatorError("capture", "unavailable");
    }
    if (!isPlainObject(value)
      || !hasExactKeys(value, ["assess", "compileCut"])
      || typeof value.assess !== "function"
      || typeof value.compileCut !== "function") {
      throw coordinatorError("capture", "malformed_dependency");
    }
    return value as unknown as ArtifactCurrentConflictCapture;
  }

  private readCompileCut(
    capture: ArtifactCurrentConflictCapture,
    risk: ArtifactRiskAssessment,
  ): ArtifactCurrentConflictCompileCut {
    let raw: unknown;
    try {
      raw = capture.compileCut();
    } catch {
      throw coordinatorError("capture", "unavailable");
    }
    if (raw === undefined || !isPlainObject(raw)
      || !hasExactKeys(raw, ["currentConflict", "foreignRuleChecks", "foreignCatalogIdentity"])) {
      throw coordinatorError("capture", "malformed_dependency");
    }
    try {
      const currentConflict = parseCurrentConflict(raw.currentConflict);
      if (risk.conflictInputIdentity !== currentConflict.sourceIdentity
        || !Array.isArray(raw.foreignRuleChecks)
        || raw.foreignRuleChecks.length > 20
        || typeof raw.foreignCatalogIdentity !== "string") {
        throw new Error("compile cut binding mismatch");
      }
      const foreignRuleChecks = raw.foreignRuleChecks.map((check) => parseNeutralConflictInput(check));
      if (computeNeutralForeignCatalogIdentity(foreignRuleChecks) !== raw.foreignCatalogIdentity) {
        throw new Error("foreign catalog identity mismatch");
      }
      if (!isDigest(raw.foreignCatalogIdentity)) throw new Error("foreign catalog identity is invalid");
      return Object.freeze({
        currentConflict,
        foreignRuleChecks: Object.freeze(foreignRuleChecks),
        foreignCatalogIdentity: raw.foreignCatalogIdentity,
      });
    } catch {
      throw coordinatorError("capture", "malformed_dependency");
    }
  }

  private readWorldCut(input: ArtifactWorldCutInput): NeutralWorldCut {
    let raw: unknown;
    try {
      raw = this.worldCut.read(input);
    } catch {
      throw coordinatorError("world-cut", "unavailable");
    }
    if (isPromiseLike(raw)) throw coordinatorError("world-cut", "malformed_dependency");
    try {
      return parseNeutralWorldCut(raw);
    } catch {
      throw coordinatorError("world-cut", "malformed_dependency");
    }
  }

  private readExactProposal(proposalId: string, revision: number): ArtifactCompilationProposal {
    let raw: unknown;
    try {
      raw = this.proposals.get(proposalId);
    } catch {
      throw coordinatorError("proposal", "unavailable");
    }
    if (isPromiseLike(raw) || !isPlainObject(raw)
      || raw.id !== proposalId
      || raw.revision !== revision
      || !isProposalStatus(raw.status)) {
      throw coordinatorError("proposal", raw === undefined ? "not_found" : "malformed_dependency");
    }
    return Object.freeze({ id: raw.id, revision: raw.revision, status: raw.status });
  }

  private createCompileInput(input: Parameters<typeof createArtifactCompileInput>[0]): ArtifactCompileInput {
    try {
      return parseArtifactCompileInput(createArtifactCompileInput(input));
    } catch {
      throw coordinatorError("compile-input", "malformed_dependency");
    }
  }

  private readCompilerIdentity(): ArtifactCompileInput["compiler"] {
    return this.compilerIdentity;
  }

  private runCompiler(input: ArtifactCompileInput): ArtifactCompileAttestation {
    let raw: unknown;
    try {
      raw = this.compiler(input);
    } catch {
      throw coordinatorError("compile", "unavailable");
    }
    if (isPromiseLike(raw)) throw coordinatorError("compile", "malformed_result");
    let result: ArtifactCompileAttestation;
    try {
      result = parseArtifactCompileAttestation(raw);
    } catch {
      throw coordinatorError("compile", "malformed_result");
    }
    if (!sameCompileInputBinding(result, input)) throw coordinatorError("compile", "malformed_result");
    return result;
  }

  private runDryRun(compile: ArtifactCompileAttestation): NeutralDryRunAttestation {
    let raw: unknown;
    try {
      raw = this.dryRun(compile);
    } catch {
      throw coordinatorError("dry-run", "unavailable");
    }
    if (isPromiseLike(raw)) throw coordinatorError("dry-run", "malformed_result");
    let result: NeutralDryRunAttestation;
    try {
      result = parseNeutralDryRunAttestation(raw);
    } catch {
      throw coordinatorError("dry-run", "malformed_result");
    }
    if (!sameDryRunBinding(result, compile) || result.writesPerformed !== false) {
      throw coordinatorError("dry-run", "malformed_result");
    }
    return result;
  }

  private recordCompile(result: ArtifactCompileAttestation): ArtifactCompilationResultEntry<ArtifactCompileAttestation> {
    let raw: unknown;
    try {
      raw = this.registry.recordCompile({
        result,
        idempotencyKey: `artifact-compile-${result.inputIdentity}`,
      });
    } catch {
      throw coordinatorError("compile-persist", "persistence_failed");
    }
    return validateResultEntry(raw, result, "compile-persist");
  }

  private recordDryRun(result: NeutralDryRunAttestation): ArtifactCompilationResultEntry<NeutralDryRunAttestation> {
    let raw: unknown;
    try {
      raw = this.registry.recordDryRun({
        result,
        idempotencyKey: `artifact-dry-run-${result.inputIdentity}`,
      });
    } catch {
      throw coordinatorError("dry-run-persist", "persistence_failed");
    }
    return validateResultEntry(raw, result, "dry-run-persist");
  }
}

function validateResultEntry<T extends ArtifactCompileAttestation | NeutralDryRunAttestation>(
  value: unknown,
  expected: T,
  stage: "compile-persist" | "dry-run-persist",
): ArtifactCompilationResultEntry<T> {
  if (!isPlainObject(value)
    || !hasOnlyKeys(value, ["kind", "resultId", "artifact", "inputIdentity", "sequence", "recordedAt", "result", "audit"])
    || (value.kind !== expected.kind)
    || typeof value.resultId !== "string"
    || !isExactArtifactRef(value.artifact, expected.artifact)
    || value.inputIdentity !== expected.inputIdentity
    || !isPlainObject(value.result)) {
    throw coordinatorError(stage, "malformed_result");
  }
  if (value.sequence !== undefined
    && (typeof value.sequence !== "number" || !Number.isSafeInteger(value.sequence) || value.sequence < 1)) {
    throw coordinatorError(stage, "malformed_result");
  }
  if (value.recordedAt !== undefined && typeof value.recordedAt !== "string") {
    throw coordinatorError(stage, "malformed_result");
  }
  if (value.audit !== undefined && !Array.isArray(value.audit)) {
    throw coordinatorError(stage, "malformed_result");
  }
  let parsed: T;
  try {
    parsed = expected.kind === "compile-attestation"
      ? parseArtifactCompileAttestation(value.result) as T
      : parseNeutralDryRunAttestation(value.result) as T;
  } catch {
    throw coordinatorError(stage, "malformed_result");
  }
  if (parsed.resultId !== expected.resultId
    || parsed.inputIdentity !== expected.inputIdentity
    || !isExactArtifactRef(parsed.artifact, expected.artifact)
    || value.resultId !== expected.resultId) {
    throw coordinatorError(stage, "malformed_result");
  }
  return value as unknown as ArtifactCompilationResultEntry<T>;
}

function parseCurrentConflict(value: unknown): ArtifactCurrentConflictCompileCut["currentConflict"] {
  if (!isPlainObject(value)
    || !hasExactKeys(value, ["sourceIdentity", "result"])
    || !isDigest(value.sourceIdentity)) {
    throw new Error("Current conflict is invalid");
  }
  return Object.freeze({
    sourceIdentity: value.sourceIdentity,
    result: parseNeutralConflictResult(value.result),
  });
}

function assertRiskDependencies(
  risk: ArtifactRiskAssessment,
  evidence: ArtifactEvidenceAttestation,
  authority: ArtifactAuthorityAssessment,
): void {
  if (risk.evidence.attestationId !== evidence.attestationId
    || risk.evidence.inputIdentity !== evidence.inputIdentity
    || risk.authority.assessmentId !== authority.assessmentId
    || risk.authority.inputIdentity !== authority.inputIdentity) {
    throw coordinatorError("risk", "malformed_dependency");
  }
}

function sameCompileInputBinding(result: ArtifactCompileAttestation, input: ArtifactCompileInput): boolean {
  return sameArtifactRef(result.artifact, artifactRef(input.artifact))
    && result.inputIdentity === input.inputIdentity
    && result.proposal.id === input.proposal.id
    && result.proposal.revision === input.proposal.revision
    && result.evidenceAttestationId === input.evidence.attestationId
    && result.evidenceInputIdentity === input.evidence.inputIdentity
    && result.riskAssessmentId === input.risk.assessmentId
    && result.riskInputIdentity === input.risk.inputIdentity
    && result.authorityAssessmentId === input.authority.assessmentId
    && result.authorityInputIdentity === input.authority.inputIdentity
    && result.worldCutIdentity === input.worldCut.cutIdentity
    && result.foreignCatalogIdentity === input.foreignCatalogIdentity
    && result.compiler.id === input.compiler.id
    && result.compiler.version === input.compiler.version;
}

function sameDryRunBinding(result: NeutralDryRunAttestation, compile: ArtifactCompileAttestation): boolean {
  return sameArtifactRef(result.artifact, compile.artifact)
    && result.compileAttestationId === compile.resultId
    && result.compileInputIdentity === compile.inputIdentity
    && result.evidenceAttestationId === compile.evidenceAttestationId
    && result.evidenceInputIdentity === compile.evidenceInputIdentity
    && result.riskAssessmentId === compile.riskAssessmentId
    && result.riskInputIdentity === compile.riskInputIdentity
    && result.authorityAssessmentId === compile.authorityAssessmentId
    && result.authorityInputIdentity === compile.authorityInputIdentity
    && result.worldCutIdentity === compile.worldCutIdentity
    && result.foreignCatalogIdentity === compile.foreignCatalogIdentity
    && result.compiler.id === compile.compiler.id
    && result.compiler.version === compile.compiler.version;
}

function parseArtifactRef(value: unknown): ArtifactRef {
  try {
    return Object.freeze(artifactRefSchema.parse(value));
  } catch {
    throw coordinatorError("artifact", "invalid_input");
  }
}

function artifactRef(value: ArtifactRevision): ArtifactRef {
  return artifactRefSchema.parse({
    artifactId: value.artifactId,
    revision: value.revision,
    contentHash: value.contentHash,
  });
}

function sameArtifactRef(left: unknown, right: ArtifactRef): boolean {
  return isPlainObject(left)
    && left.artifactId === right.artifactId
    && left.revision === right.revision
    && left.contentHash === right.contentHash;
}

function isExactArtifactRef(left: unknown, right: ArtifactRef): boolean {
  try {
    const parsed = artifactRefSchema.parse(left);
    return sameArtifactRef(parsed, right);
  } catch {
    return false;
  }
}

function stageForAssessment(kind: "evidence-attestation" | "risk-assessment" | "authority-assessment"): "evidence" | "risk" | "authority" {
  return kind === "evidence-attestation" ? "evidence" : kind === "risk-assessment" ? "risk" : "authority";
}

function coordinatorError(
  stage: ArtifactCompilationCoordinatorStage,
  code: ArtifactCompilationCoordinatorFailureCode,
): ArtifactCompilationCoordinatorError {
  return new ArtifactCompilationCoordinatorError(stage, code);
}

function assertStrictOptions(value: unknown): asserts value is ArtifactCompilationCoordinatorOptions {
  if (!isPlainObject(value)) throw new TypeError("Artifact compilation coordinator options are invalid");
  const allowed = ["registry", "proposals", "proposal", "conflict", "currentConflict", "worldCut", "compiler", "dryRun"];
  if (!hasOnlyKeys(value, allowed)
    || !isObjectLike(value.registry)
    || typeof value.registry.getRevision !== "function"
    || typeof value.registry.latestAttestation !== "function"
    || typeof value.registry.recordCompile !== "function"
    || typeof value.registry.recordDryRun !== "function"
    || !hasExactlyOne(value.proposals, value.proposal)
    || !hasExactlyOne(value.conflict, value.currentConflict)
    || !isObjectLike(value.worldCut)
    || typeof value.worldCut.read !== "function"
    || !isCompilerPort(value.compiler)
    || !isDryRunPort(value.dryRun)) {
    throw new TypeError("Artifact compilation coordinator options are invalid");
  }
}

function hasExactlyOne(left: unknown, right: unknown): boolean {
  const leftPresent = left !== undefined;
  const rightPresent = right !== undefined;
  if (leftPresent === rightPresent) return false;
  const value = leftPresent ? left : right;
  return isObjectLike(value);
}

function isCompilerPort(value: unknown): value is ArtifactCompilationCompilerPort {
  return isObjectLike(value)
    && hasExactKeys(value, ["id", "version", "compile"])
    && neutralCompilerSchema.safeParse({ id: value.id, version: value.version }).success
    && typeof value.compile === "function";
}

function isDryRunPort(value: unknown): value is NeutralDryRunProducer | ArtifactCompilationDryRunPort {
  return typeof value === "function"
    || (isObjectLike(value) && typeof value.produce === "function");
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Reflect.ownKeys(value).every((key) => typeof key === "string" && allowed.includes(key));
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length && keys.every((key) => typeof key === "string" && expected.includes(key));
}

function isProposalStatus(value: unknown): value is ArtifactCompilationProposalStatus {
  return value === "pending_review" || value === "approved" || value === "rejected" || value === "expired";
}

function isDigest(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return value !== null && (typeof value === "object" || typeof value === "function");
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === "object" && value !== null || typeof value === "function")
    && typeof (value as { readonly then?: unknown }).then === "function";
}

function assertCoordinatorReceiver(value: unknown): asserts value is ArtifactCompilationCoordinator {
  if (!(value instanceof ArtifactCompilationCoordinator)) {
    throw new TypeError("Artifact compilation coordinator receiver is invalid");
  }
}

function freezeDeep<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child, seen);
  return Object.freeze(value);
}
