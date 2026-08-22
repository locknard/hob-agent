import type { Context } from "@deepseek-ai/cordis";

import { ArtifactAuthorityProducer } from "./artifact-authority-producer.js";
import {
  ArtifactCompilationCoordinator,
  ArtifactCompilationCoordinatorError,
} from "./artifact-compilation-coordinator.js";
import {
  parseArtifactAuthorityAssessment,
  parseArtifactEvidenceAttestation,
  parseArtifactRiskAssessment,
} from "./artifact-assessments.js";
import { compileNeutralArtifact } from "./artifact-compiler.js";
import { ArtifactRiskConflictSource } from "./artifact-conflict-source.js";
import { ArtifactCurrentConflictSource } from "./artifact-current-conflict-source.js";
import { neutralDryRunProducer } from "./artifact-dry-run.js";
import { ArtifactEvidenceProducer } from "./artifact-evidence-producer.js";
import {
  ArtifactPreparationService,
  ArtifactPreparationServiceError,
  type ArtifactPreparationReceipt,
} from "./artifact-preparation-service.js";
import { ArtifactProducer } from "./artifact-producer.js";
import { ArtifactRiskProducer } from "./artifact-risk-producer.js";
import type { ArtifactRegistry } from "./artifact-registry.js";
import { ArtifactWorldCutSource } from "./artifact-world-cut-source.js";
import type {
  AuthorityCandidateRegistry,
  AuthorityCandidateResolveInput,
} from "../authority-candidate-registry.js";
import {
  checkCapabilityAction,
  checkCapabilityPredicate,
  resolveCapabilityRead,
} from "../bridge/capability-semantics.js";
import {
  HomeArtifactService,
  type HomeArtifactRegistryReader,
} from "../home-artifact-service.js";
import { HomeWorldAuthorityBindingSource } from "../home-world-authority-binding-source.js";
import type { ArtifactMutationProposalCommand } from "./artifact-mutation-coordinator.js";
import type { ArtifactRef } from "./neutral-artifact.js";
import type { SqliteProposalStore } from "../proposal-store.js";
import type {
  HomeWorldEvidenceQuery,
  HomeWorldEvidenceResult,
  HomeWorldForeignRuleCatalog,
  HomeWorldSnapshot,
} from "../home-world-service.js";

interface PipelineProposalPort {
  readonly get: SqliteProposalStore["get"];
  readonly withApprovedProposalAtRevision: SqliteProposalStore["withApprovedProposalAtRevision"];
}

interface PipelineHomeWorldPort {
  readonly snapshot: () => HomeWorldSnapshot;
  readonly queryRecentEvidence: (input: HomeWorldEvidenceQuery) => HomeWorldEvidenceResult;
  readonly foreignRuleCatalog: () => Promise<readonly HomeWorldForeignRuleCatalog[]>;
  readonly resolveAuthorityCandidateInput?: (hwCapabilityId: string) => AuthorityCandidateResolveInput | undefined;
  readonly isActionAuthorityConfiguredForBridge?: (hwCapabilityId: string, bridgeId: string) => boolean;
  readonly resolveActionAuthority?: (hwCapabilityId: string) => { readonly status: "available" | "unavailable"; readonly bridgeId?: string };
}

export interface ArtifactPipelineCompositionOptions {
  readonly context: Context;
  readonly proposals: PipelineProposalPort;
  readonly homeWorld: PipelineHomeWorldPort;
  readonly artifacts: ArtifactRegistry;
  readonly authorityCandidates: Pick<AuthorityCandidateRegistry, "resolve">;
  readonly now?: () => string;
}

export interface ArtifactPipelineComposition {
  readonly prepare: (command: ArtifactMutationProposalCommand) => Promise<ArtifactPreparationReceipt>;
  readonly stop: () => Promise<void>;
}

/**
 * Builds the non-applying Artifact pipeline around root-owned stores. Only the
 * bounded HomeArtifactService reader is mounted into Cordis.
 */
export async function createArtifactPipelineComposition(
  options: ArtifactPipelineCompositionOptions,
): Promise<ArtifactPipelineComposition> {
  const registry = registryPorts(options.artifacts);
  const proposals = {
    get: options.proposals.get.bind(options.proposals),
    withApprovedProposalAtRevision: options.proposals.withApprovedProposalAtRevision.bind(options.proposals),
  };
  const homeWorld = {
    snapshot: options.homeWorld.snapshot.bind(options.homeWorld),
    queryRecentEvidence: options.homeWorld.queryRecentEvidence.bind(options.homeWorld),
    foreignRuleCatalog: options.homeWorld.foreignRuleCatalog.bind(options.homeWorld),
    resolveAuthorityCandidateInput: options.homeWorld.resolveAuthorityCandidateInput?.bind(options.homeWorld)
      ?? (() => undefined),
    isActionAuthorityConfiguredForBridge: options.homeWorld.isActionAuthorityConfiguredForBridge?.bind(options.homeWorld)
      ?? (() => false),
    resolveActionAuthority: options.homeWorld.resolveActionAuthority?.bind(options.homeWorld)
      ?? (() => ({ status: "unavailable" as const })),
  };

  await options.context.plugin(HomeArtifactService, { registry: registry.reader });

  const existingConflict = new ArtifactRiskConflictSource({ proposals, registry: registry.conflict });
  const artifactProducer = new ArtifactProducer({
    proposals,
    registry: registry.draft,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const evidenceProducer = new ArtifactEvidenceProducer({
    proposals,
    homeWorld,
    registry: registry.evidence,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const authorityProducer = new ArtifactAuthorityProducer({
    artifacts: registry.authority,
    authority: { resolve: options.authorityCandidates.resolve.bind(options.authorityCandidates) },
    bindingInput: new HomeWorldAuthorityBindingSource({ homeWorld }),
  });
  const currentConflict = new ArtifactCurrentConflictSource({
    proposals,
    registry: registry.currentConflict,
    homeWorld,
    existing: existingConflict,
  });
  const worldCut = new ArtifactWorldCutSource({
    artifacts: registry.worldCut,
    homeWorld: { snapshot: homeWorld.snapshot },
    resolver: {
      resolveRead: resolveCapabilityRead,
      checkPredicate: checkCapabilityPredicate,
      checkAction: checkCapabilityAction,
    },
  });
  const preparation = new ArtifactPreparationService({
    pipeline: {
      run: async (command) => {
        const artifactEntry = runStage("artifact", () => artifactProducer.produce(command));
        const artifact = Object.freeze({
          artifactId: artifactEntry.artifact.artifactId,
          revision: artifactEntry.artifact.revision,
          contentHash: artifactEntry.artifact.contentHash,
        });
        const evidenceEntry = runStage("evidence", () => evidenceProducer.produce({ artifact }));
        const evidence = runStage("evidence", () => parseArtifactEvidenceAttestation(evidenceEntry.assessment));
        const authorityEntry = runStage("authority", () => authorityProducer.produce(artifact));
        const authority = runStage("authority", () => parseArtifactAuthorityAssessment(authorityEntry.assessment));
        const capture = await runAsyncStage("compile", () => currentConflict.capture({ artifact, evidence }));
        const riskEntry = runStage("risk", () => new ArtifactRiskProducer({
          registry: registry.risk,
          conflict: capture,
          ...(options.now === undefined ? {} : { now: options.now }),
        }).produce(artifact));
        const risk = runStage("risk", () => parseArtifactRiskAssessment(riskEntry.assessment));
        const compilation = new ArtifactCompilationCoordinator({
          registry: registry.compilation,
          proposals: { get: proposals.get },
          conflict: fixedCapture(capture, artifact, evidence),
          worldCut,
          compiler: {
            id: "neutral-compiler",
            version: "1.0.0",
            compile: compileNeutralArtifact,
          },
          dryRun: neutralDryRunProducer,
        });
        let compilationReceipt;
        try {
          compilationReceipt = await compilation.compile(artifact);
        } catch (error) {
          if (error instanceof ArtifactCompilationCoordinatorError) {
            throw new ArtifactPreparationServiceError(error.stage, "failed");
          }
          throw new ArtifactPreparationServiceError("compile", "failed");
        }
        return {
          mutation: {
            artifact,
            evidence: { attestationId: evidence.attestationId, inputIdentity: evidence.inputIdentity },
            authority: { assessmentId: authority.assessmentId, inputIdentity: authority.inputIdentity },
            risk: { assessmentId: risk.assessmentId, inputIdentity: risk.inputIdentity },
          },
          compilation: compilationReceipt,
        };
      },
    },
  });
  return Object.freeze({
    prepare: preparation.prepare.bind(preparation),
    stop: preparation.stop.bind(preparation),
  });
}

function runStage<T>(
  stage: "artifact" | "evidence" | "authority" | "risk",
  operation: () => T,
): T {
  try {
    return operation();
  } catch {
    throw new ArtifactPreparationServiceError(stage, "failed");
  }
}

async function runAsyncStage<T>(stage: "compile", operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    throw new ArtifactPreparationServiceError(stage, "failed");
  }
}

function fixedCapture(
  capture: Awaited<ReturnType<ArtifactCurrentConflictSource["capture"]>>,
  artifact: ArtifactRef,
  evidence: ReturnType<typeof parseArtifactEvidenceAttestation>,
) {
  return {
    async capture(input: { readonly artifact: ArtifactRef; readonly evidence: typeof evidence }) {
      if (!sameArtifact(input.artifact, artifact)
        || input.evidence.attestationId !== evidence.attestationId
        || input.evidence.inputIdentity !== evidence.inputIdentity) {
        throw new Error("captured conflict input changed");
      }
      return capture;
    },
  };
}

function sameArtifact(left: ArtifactRef, right: ArtifactRef): boolean {
  return left.artifactId === right.artifactId
    && left.revision === right.revision
    && left.contentHash === right.contentHash;
}

function registryPorts(registry: ArtifactRegistry) {
  const getRevision = registry.getRevision.bind(registry);
  const latestAttestation = registry.latestAttestation.bind(registry);
  return {
    reader: {
      getRevision,
      list: registry.list.bind(registry),
      audit: registry.audit.bind(registry),
      listAttestations: registry.listAttestations.bind(registry),
      latestAttestation,
      currentBySourceProposal: registry.currentBySourceProposal.bind(registry),
      latestResult: registry.latestResult.bind(registry),
    } satisfies HomeArtifactRegistryReader,
    draft: { createDraft: registry.createDraft.bind(registry) },
    evidence: {
      getRevision,
      listAttestations: registry.listAttestations.bind(registry),
      recordEvidenceAttestation: registry.recordEvidenceAttestation.bind(registry),
    },
    authority: {
      getRevision,
      recordAuthorityAssessment: registry.recordAuthorityAssessment.bind(registry),
    },
    risk: {
      getRevision,
      latestAttestation,
      attestationByInputIdentity: registry.attestationByInputIdentity.bind(registry),
      recordRiskAssessment: registry.recordRiskAssessment.bind(registry),
    },
    conflict: { getRevision, list: registry.list.bind(registry) },
    currentConflict: { getRevision },
    worldCut: { getRevision },
    compilation: {
      getRevision,
      latestAttestation,
      recordCompile: registry.recordCompile.bind(registry),
      recordDryRun: registry.recordDryRun.bind(registry),
    },
  };
}
