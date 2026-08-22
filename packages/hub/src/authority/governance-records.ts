import type { IdentityClaim } from "@hob/bridge-contract";

export type IdentityClaimSourceKind = IdentityClaim["source"]["kind"];

export type GovernanceProposalKind =
  | "identity-link"
  | "capability-binding"
  | "action-authority-binding"
  | "state-authority-switch";

export interface GovernanceProposal {
  readonly id: string;
  readonly kind: GovernanceProposalKind;
  readonly status: "proposed" | "approved" | "rejected" | "applied";
  readonly createdAt: string;
  readonly requiresHumanApproval: boolean;
  readonly sourceKind?: IdentityClaimSourceKind;
  readonly hwId?: string;
  readonly targetHwId?: string;
  readonly hwCapabilityId?: string;
  readonly targetHwCapabilityId?: string;
  readonly bridgeId?: string;
  readonly reason: string;
}

export interface GovernanceAuditRecord {
  readonly id: string;
  readonly kind:
    | "identity-observed"
    | "identity-auto-merged"
    | "identity-link-proposed"
    | "capability-binding-proposed"
    | "state-authority-switched"
    | "action-authority-proposed";
  readonly at: string;
  readonly hwId?: string;
  readonly hwCapabilityId?: string;
  readonly bridgeId?: string;
  readonly fromBridgeId?: string;
  readonly toBridgeId?: string;
  readonly proposalId?: string;
  readonly outcome: "observed" | "merged" | "proposed" | "switched";
}
