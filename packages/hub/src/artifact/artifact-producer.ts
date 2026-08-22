import { createHash } from "node:crypto";

import {
  createArtifactRevision,
  type ArtifactRevision,
  type CreateArtifactRevisionInput,
} from "./neutral-artifact.js";
import type { ArtifactRegistryEntry } from "./artifact-registry.js";
import type { HubVerifiedProposalSource } from "../home/proposal-store.js";

/**
 * The only proposal read seam an Artifact producer may use. The concrete
 * HomeProposalService implements this shape and owns the approval/audit gate.
 */
export interface ApprovedProposalSource {
  withApprovedProposalAtRevision<T>(
    proposalId: string,
    revision: number,
    operation: (source: HubVerifiedProposalSource) => T,
  ): T;
}

/**
 * The producer can only create a draft. It has no update, route, credential,
 * bridge, or remote-write capability.
 */
export interface ArtifactDraftRegistry {
  createDraft(input: {
    readonly artifact: ArtifactRevision;
    readonly idempotencyKey: string;
    readonly actor?: string;
  }): ArtifactRegistryEntry;
}

export interface ArtifactProducerOptions {
  readonly proposals: ApprovedProposalSource;
  readonly registry: ArtifactDraftRegistry;
  /** Injectable Hub clock for deterministic tests; it is not a request field. */
  readonly now?: () => string;
}

/** Deliberately contains no candidate content, assessments, or route fields. */
export interface ArtifactProductionRequest {
  readonly proposalId: string;
  readonly proposalRevision: number;
}

const ARTIFACT_PRODUCER_VERSION = "artifact-producer-v1";

/**
 * Converts one exact, approved automation Proposal revision into Artifact
 * revision one. This is a pure local projection plus one registry draft write;
 * it never has a bridge, credential, or device route.
 */
export class ArtifactProducer {
  private readonly proposals: ApprovedProposalSource;
  private readonly registry: ArtifactDraftRegistry;
  private readonly now: () => string;

  constructor(options: ArtifactProducerOptions) {
    if (!options || typeof options !== "object") {
      throw new TypeError("Artifact producer options are required");
    }
    if (!options.proposals || typeof options.proposals.withApprovedProposalAtRevision !== "function") {
      throw new TypeError("Artifact producer requires an approved proposal source");
    }
    if (!options.registry || typeof options.registry.createDraft !== "function") {
      throw new TypeError("Artifact producer requires an artifact registry");
    }
    if (options.now !== undefined && typeof options.now !== "function") {
      throw new TypeError("Artifact producer clock must be callable");
    }
    this.proposals = options.proposals;
    this.registry = options.registry;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  produce(request: ArtifactProductionRequest): ArtifactRegistryEntry {
    assertProductionRequest(request);
    const identity = deriveIdentity(request);

    return this.proposals.withApprovedProposalAtRevision(
      request.proposalId,
      request.proposalRevision,
      (source) => {
        assertApprovedSource(source, request);

        const artifactInput: CreateArtifactRevisionInput = {
          schemaVersion: "1",
          kind: "event-condition-action",
          artifactId: identity.artifactId,
          revision: 1,
          title: source.title,
          summary: source.summary,
          sourceProposal: {
            proposalId: source.proposalId,
            proposalRevision: source.revision,
          },
          // The candidate has already been admitted and preserved by the
          // proposal gate. No caller-provided field is consulted here.
          // HubVerifiedProposalSource is deeply readonly by design while the
          // canonical constructor accepts its validated structural shape. The
          // cast is type-only; neither this producer nor the constructor
          // mutates the candidate.
          content: source.artifactCandidate.content as CreateArtifactRevisionInput["content"],
          createdAt: this.now(),
        };
        const artifact = createArtifactRevision(artifactInput);

        return this.registry.createDraft({
          artifact,
          idempotencyKey: identity.idempotencyKey,
        });
      },
    );
  }
}

function assertProductionRequest(value: unknown): asserts value is ArtifactProductionRequest {
  if (value === null || typeof value !== "object") {
    throw new TypeError("Artifact production request is invalid");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Artifact production request is invalid");
  }

  const keys = Reflect.ownKeys(value);
  if (keys.length !== 2 || !keys.every((key) => key === "proposalId" || key === "proposalRevision")) {
    throw new TypeError("Artifact production request contains unsupported fields");
  }

  const request = value as Record<string, unknown>;
  if (typeof request.proposalId !== "string"
    || request.proposalId.length === 0
    || request.proposalId.trim() !== request.proposalId
    || Buffer.byteLength(request.proposalId, "utf8") > 200) {
    throw new TypeError("Artifact production proposal identity is invalid");
  }
  if (typeof request.proposalRevision !== "number"
    || !Number.isSafeInteger(request.proposalRevision)
    || request.proposalRevision < 1) {
    throw new TypeError("Artifact production proposal revision is invalid");
  }
}

function assertApprovedSource(
  source: HubVerifiedProposalSource,
  request: ArtifactProductionRequest,
): void {
  if (source === null || typeof source !== "object"
    || source.proposalId !== request.proposalId
    || source.revision !== request.proposalRevision
    || source.kind !== "automation-draft"
    || source.status !== "approved"
    || source.applicationStatus !== "not_available"
    || source.artifactCandidate === undefined
    || source.artifactCandidate === null
    || typeof source.artifactCandidate !== "object"
    || source.artifactCandidate.schemaVersion !== "1") {
    throw new TypeError("Approved proposal source identity does not match request");
  }
}

function deriveIdentity(request: ArtifactProductionRequest): {
  readonly artifactId: string;
  readonly idempotencyKey: string;
} {
  // Do not put proposal identifiers in durable artifact identifiers. The
  // digest is deterministic so a retry after a process/registry restart maps
  // to the same Hub-owned artifact and registry idempotency record.
  const digest = createHash("sha256")
    .update(`${ARTIFACT_PRODUCER_VERSION}\0${request.proposalId}\0${request.proposalRevision}`, "utf8")
    .digest("hex");
  return {
    artifactId: `artifact-${digest}`,
    idempotencyKey: `${ARTIFACT_PRODUCER_VERSION}-${digest}`,
  };
}
