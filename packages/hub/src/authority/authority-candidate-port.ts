export type NeutralAuthorityCandidateStatus = "available" | "unavailable" | "not_approved";

/** Neutral authority projection available to artifact assessment. */
export interface NeutralAuthorityCandidate {
  readonly actionAuthorityCandidateId: string;
  readonly hwCapabilityId: string;
  readonly status: NeutralAuthorityCandidateStatus;
}

/**
 * Hub-owned inputs for one candidate resolution. Binding and configuration
 * identities are opaque Hub digests; this port carries no route or credential.
 */
export interface AuthorityCandidateResolveInput {
  readonly hwCapabilityId: string;
  readonly knownCapability: boolean;
  readonly configured: boolean;
  readonly approved: boolean;
  readonly available: boolean;
  readonly bindingIdentity?: string;
  readonly configurationIdentity?: string;
  readonly registrationGeneration?: number;
}

export interface AuthorityCandidateResolution {
  readonly authorityRegistryIdentity: `sha256:${string}`;
  readonly candidate: NeutralAuthorityCandidate;
}

export interface AuthorityCandidateResolutionPort {
  readonly resolve: (input: AuthorityCandidateResolveInput) => AuthorityCandidateResolution;
}
