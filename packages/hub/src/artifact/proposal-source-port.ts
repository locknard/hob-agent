import type { ArtifactContent } from "./neutral-artifact.js";

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export interface VerifiedProposalIntent {
  readonly type: string;
  readonly description: string;
  readonly rollback: string;
}

export interface VerifiedProposalConflictMatch {
  readonly identity: string;
  readonly relation: "duplicate" | "conflict" | "possible_overlap";
}

export interface VerifiedProposalConflictCheck {
  readonly status: "checked" | "unavailable";
  readonly existingAutomationCount: number;
  readonly matches: readonly VerifiedProposalConflictMatch[];
}

/**
 * Exact immutable projection admitted by the home-owned approval/audit gate.
 * Evidence and risk remain opaque here: their artifact owners parse and bind
 * them before use instead of trusting this TypeScript shape as validation.
 */
export type HubVerifiedProposalSource = DeepReadonly<{
  readonly proposalId: string;
  readonly revision: number;
  readonly kind: "automation-draft";
  readonly status: "approved";
  readonly applicationStatus: "not_available";
  readonly title: string;
  readonly summary: string;
  readonly intent: VerifiedProposalIntent;
  readonly evidence: unknown;
  readonly conflictCheck: VerifiedProposalConflictCheck;
  readonly risk: unknown;
  readonly artifactCandidate: {
    readonly schemaVersion: "1";
    readonly content: ArtifactContent;
  };
}>;

/** Synchronous exact-revision proposal source available to artifact producers. */
export interface ApprovedProposalSource {
  withApprovedProposalAtRevision<T>(
    proposalId: string,
    revision: number,
    operation: (source: HubVerifiedProposalSource) => T,
  ): T;
}
