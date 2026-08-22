import { createHash } from "node:crypto";

import type {
  AdapterCapabilityRef,
  DeviceDescriptor,
  IdentityClaim,
  WorldCapability,
  WorldSpace,
} from "@hob/bridge-contract";
import type {
  GovernanceAuditRecord,
  GovernanceProposal,
  IdentityClaimSourceKind,
} from "../authority/governance-records.js";

export type {
  GovernanceAuditRecord,
  GovernanceProposal,
  GovernanceProposalKind,
  IdentityClaimSourceKind,
} from "../authority/governance-records.js";

export interface WorldIdentity {
  readonly hwId: string;
  readonly claims: readonly IdentityClaim[];
}

export interface IdentityObservation {
  readonly identity: WorldIdentity;
  readonly capabilities: readonly WorldCapability[];
  readonly autoMerged: boolean;
  readonly proposals: readonly GovernanceProposal[];
  readonly audit: readonly GovernanceAuditRecord[];
}

export type IdentityIdKind = "hw" | "hwCapability" | "hwSpace" | "proposal" | "audit";

export interface WorldIdentityManagerOptions {
  readonly now?: () => string | Date;
  readonly idFactory?: (kind: IdentityIdKind) => string;
}

export class WorldIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorldIdentityError";
  }
}

interface MutableIdentity {
  hwId: string;
  claims: IdentityClaim[];
}

interface DeviceRegistration {
  readonly key: string;
  readonly hwId: string;
  readonly capabilityIdsByKey: Map<string, string>;
}

/**
 * Hub-owned identity allocator. Device claims can identify an existing device
 * only when their provenance is explicitly eligible; capability equivalence
 * is always a proposal unless a later policy layer applies it.
 */
export class WorldIdentityManager {
  private readonly now: () => string;
  private readonly idFactory: ((kind: IdentityIdKind) => string) | undefined;
  private readonly identities = new Map<string, MutableIdentity>();
  private readonly devices = new Map<string, DeviceRegistration>();
  private readonly capabilities = new Map<string, WorldCapability>();
  private readonly spaces = new Map<string, WorldSpace>();
  private readonly spaceIdsByBinding = new Map<string, string>();
  private readonly claimIndex = new Map<string, Set<string>>();
  private readonly proposalsById = new Map<string, GovernanceProposal>();
  private readonly audit: GovernanceAuditRecord[] = [];
  private readonly counters = new Map<IdentityIdKind, number>();

  constructor(options: WorldIdentityManagerOptions = {}) {
    this.now = () => normalizeTime(options.now?.() ?? new Date());
    this.idFactory = options.idFactory;
  }

  observe(bridgeId: string, descriptor: DeviceDescriptor): IdentityObservation {
    requireText(bridgeId, "bridgeId");
    requireText(descriptor?.nativeId, "nativeId");
    const deviceKey = `${bridgeId}\u0000${descriptor.nativeId}`;
    const prior = this.devices.get(deviceKey);
    if (prior !== undefined) return this.observeExisting(prior, descriptor);

    const claims = cloneClaims(descriptor.identityClaims ?? []);
    const eligibleMatches = this.findMatches(claims, true);
    const ineligibleMatches = this.findMatches(claims, false);
    const canMerge = eligibleMatches.size === 1 && !hasConflictingMatches(eligibleMatches, ineligibleMatches);
    const identity = canMerge
      ? this.requireIdentity([...eligibleMatches][0]!)
      : this.createIdentity(
        bridgeId,
        descriptor.nativeId,
        claims,
        eligibleMatches.size === 0,
      );
    const registration: DeviceRegistration = {
      key: deviceKey,
      hwId: identity.hwId,
      capabilityIdsByKey: new Map(),
    };
    this.devices.set(deviceKey, registration);
    this.indexClaims(identity.hwId, claims);
    identity.claims = mergeClaims(identity.claims, claims);
    const proposals: GovernanceProposal[] = [];
    if (canMerge) {
      this.recordAudit({
        kind: "identity-auto-merged",
        at: this.now(),
        hwId: identity.hwId,
        bridgeId,
        outcome: "merged",
      });
    }
    proposals.push(...this.identityLinkProposals(identity.hwId, claims));
    if (!canMerge && eligibleMatches.size > 0) {
      proposals.push(...this.ambiguousEligibleLinkProposals(identity.hwId, claims, eligibleMatches));
    }
    const capabilities = this.allocateCapabilities(registration, identity.hwId, bridgeId, descriptor.capabilities, proposals);
    const audit = this.takeRecentAudit(identity.hwId, bridgeId, capabilities);
    return {
      identity: cloneIdentity(identity),
      capabilities,
      autoMerged: canMerge,
      proposals,
      audit,
    };
  }

  identity(hwId: string): WorldIdentity | undefined {
    const identity = this.identities.get(hwId);
    return identity === undefined ? undefined : cloneIdentity(identity);
  }

  worldCapability(hwCapabilityId: string): WorldCapability | undefined {
    const capability = this.capabilities.get(hwCapabilityId);
    return capability === undefined ? undefined : cloneCapability(capability);
  }

  listWorldCapabilities(): readonly WorldCapability[] {
    return [...this.capabilities.values()]
      .sort((left, right) => compare(left.hwCapabilityId, right.hwCapabilityId))
      .map(cloneCapability);
  }

  listWorldSpaces(): readonly WorldSpace[] {
    return [...this.spaces.values()]
      .sort((left, right) => compare(left.hwSpaceId, right.hwSpaceId))
      .map(cloneSpace);
  }

  proposals(): readonly GovernanceProposal[] {
    return [...this.proposalsById.values()].map((proposal) => ({ ...proposal }));
  }

  auditTrail(): readonly GovernanceAuditRecord[] {
    return this.audit.map((record) => ({ ...record }));
  }

  /** Marks a proposal approved; applying its domain-specific mutation remains a policy operation. */
  approveProposal(proposalId: string): GovernanceProposal {
    const proposal = this.proposalsById.get(proposalId);
    if (proposal === undefined) throw new WorldIdentityError(`Unknown governance proposal "${proposalId}"`);
    const approved: GovernanceProposal = { ...proposal, status: "approved" };
    this.proposalsById.set(proposalId, approved);
    return { ...approved };
  }

  private observeExisting(registration: DeviceRegistration, descriptor: DeviceDescriptor): IdentityObservation {
    const identity = this.requireIdentity(registration.hwId);
    const claims = cloneClaims(descriptor.identityClaims ?? []);
    this.indexClaims(identity.hwId, claims);
    identity.claims = mergeClaims(identity.claims, claims);
    const proposals: GovernanceProposal[] = [];
    const ineligibleMatches = this.findMatches(claims, false);
    ineligibleMatches.delete(identity.hwId);
    proposals.push(...this.identityLinkProposals(identity.hwId, claims));
    const capabilities = this.allocateCapabilities(
      registration,
      identity.hwId,
      registration.key.slice(0, registration.key.indexOf("\u0000")),
      descriptor.capabilities,
      proposals,
    );
    const audit = this.takeRecentAudit(identity.hwId, undefined, capabilities);
    return { identity: cloneIdentity(identity), capabilities, autoMerged: false, proposals, audit };
  }

  private createIdentity(
    bridgeId: string,
    nativeId: string,
    claims: readonly IdentityClaim[],
    allowEligibleClaimFingerprint: boolean,
  ): MutableIdentity {
    const identity: MutableIdentity = {
      hwId: this.hubId(
        "hw",
        stableIdentityMaterial(bridgeId, nativeId, claims, allowEligibleClaimFingerprint),
      ),
      claims: cloneClaims(claims),
    };
    this.identities.set(identity.hwId, identity);
    this.recordAudit({ kind: "identity-observed", at: this.now(), hwId: identity.hwId, outcome: "observed" });
    return identity;
  }

  private allocateCapabilities(
    registration: DeviceRegistration,
    hwId: string,
    bridgeId: string,
    refs: readonly AdapterCapabilityRef[],
    proposals: GovernanceProposal[],
  ): WorldCapability[] {
    const allocated: WorldCapability[] = [];
    for (const ref of refs) {
      const nativeId = registration.key.slice(registration.key.indexOf("\u0000") + 1);
      const bindingKey = stableBindingKey(bridgeId, nativeId, ref);
      const capabilityKey = bindingKey;
      const hwSpaceId = ref.space === undefined ? undefined : this.allocateSpace(bridgeId, ref.space);
      const existingId = registration.capabilityIdsByKey.get(capabilityKey);
      if (existingId !== undefined) {
        const existing = this.requireCapability(existingId);
        const updated: WorldCapability = {
          ...existing,
          ...(ref.semanticKind === undefined ? {} : { semanticKind: ref.semanticKind }),
          bindings: existing.bindings.map((binding) => (
            binding.bridgeId === bridgeId
              && binding.nativeId === nativeId
              && binding.nativeInstanceId === ref.nativeInstanceId
              ? {
                  bridgeId,
                  nativeId,
                  nativeInstanceId: ref.nativeInstanceId,
                  ...(hwSpaceId === undefined ? {} : { hwSpaceId }),
                }
              : { ...binding }
          )),
        };
        this.capabilities.set(existingId, updated);
        allocated.push(cloneCapability(updated));
        continue;
      }
      const capability: WorldCapability = {
        hwCapabilityId: this.hubId("hwCapability", JSON.stringify([hwId, bindingKey])),
        hwId,
        schema: ref.schema,
        ...(ref.semanticKind === undefined ? {} : { semanticKind: ref.semanticKind }),
        bindings: [{
          bridgeId,
          nativeId,
          nativeInstanceId: ref.nativeInstanceId,
          ...(hwSpaceId === undefined ? {} : { hwSpaceId }),
        }],
      };
      registration.capabilityIdsByKey.set(capabilityKey, capability.hwCapabilityId);
      this.capabilities.set(capability.hwCapabilityId, capability);
      allocated.push(cloneCapability(capability));
      this.proposeSameSchemaBindings(capability, proposals);
    }
    return allocated;
  }

  private allocateSpace(
    bridgeId: string,
    ref: NonNullable<AdapterCapabilityRef["space"]>,
  ): string {
    const bindingKey = JSON.stringify([bridgeId, ref.nativeSpaceId]);
    const existingId = this.spaceIdsByBinding.get(bindingKey);
    if (existingId !== undefined) {
      const existing = this.spaces.get(existingId);
      if (existing === undefined) throw new WorldIdentityError(`Unknown hwSpaceId "${existingId}"`);
      this.spaces.set(existingId, {
        hwSpaceId: existing.hwSpaceId,
        ...(ref.name === undefined ? {} : { name: ref.name }),
        bindings: existing.bindings.map((binding) => ({ ...binding })),
      });
      return existingId;
    }
    const hwSpaceId = this.hubId("hwSpace", bindingKey);
    this.spaceIdsByBinding.set(bindingKey, hwSpaceId);
    this.spaces.set(hwSpaceId, {
      hwSpaceId,
      ...(ref.name === undefined ? {} : { name: ref.name }),
      bindings: [{ bridgeId, nativeSpaceId: ref.nativeSpaceId }],
    });
    return hwSpaceId;
  }

  private proposeSameSchemaBindings(capability: WorldCapability, proposals: GovernanceProposal[]): void {
    const candidates = [...this.capabilities.values()]
      .filter((candidate) => candidate.hwCapabilityId !== capability.hwCapabilityId
        && candidate.schema === capability.schema
        && candidate.bindings.every((binding) => binding.bridgeId !== capability.bindings[0]?.bridgeId))
      .sort((left, right) => compare(left.hwCapabilityId, right.hwCapabilityId));
    for (const candidate of candidates) {
      const proposal = this.createProposal({
        kind: "capability-binding",
        hwCapabilityId: capability.hwCapabilityId,
        targetHwCapabilityId: candidate.hwCapabilityId,
        reason: "same_schema_cross_bridge_requires_explicit_binding",
      });
      proposals.push(proposal);
      this.recordAudit({
        kind: "capability-binding-proposed",
        at: proposal.createdAt,
        hwCapabilityId: capability.hwCapabilityId,
        proposalId: proposal.id,
        outcome: "proposed",
      });
    }
  }

  private identityLinkProposals(
    hwId: string,
    claims: readonly IdentityClaim[],
  ): GovernanceProposal[] {
    const proposals: GovernanceProposal[] = [];
    for (const claim of claims) {
      if (claim.source.kind !== "platform_registry" && claim.source.kind !== "inferred") continue;
      const matches = new Set(this.claimIndex.get(claimKey(claim)) ?? []);
      matches.delete(hwId);
      const targetHwId = [...matches].sort(compare)[0];
      if (targetHwId === undefined) continue;
      const proposal = this.createProposal({
        kind: "identity-link",
        hwId,
        targetHwId,
        sourceKind: claim.source.kind,
        reason: "claim_source_requires_human_identity_review",
      });
      proposals.push(proposal);
      this.recordAudit({
        kind: "identity-link-proposed",
        at: proposal.createdAt,
        hwId,
        proposalId: proposal.id,
        outcome: "proposed",
      });
    }
    return proposals;
  }

  private ambiguousEligibleLinkProposals(
    hwId: string,
    claims: readonly IdentityClaim[],
    eligibleMatches: Set<string>,
  ): GovernanceProposal[] {
    const targetHwId = [...eligibleMatches].sort(compare)[0];
    const proposals: GovernanceProposal[] = [];
    for (const claim of claims) {
      if (!claimSourceEligibleForAutoMerge(claim.source)) continue;
      const proposal = this.createProposal({
        kind: "identity-link",
        hwId,
        targetHwId,
        sourceKind: claim.source.kind,
        reason: "ambiguous_identity_claim_requires_review",
      });
      proposals.push(proposal);
      this.recordAudit({
        kind: "identity-link-proposed",
        at: proposal.createdAt,
        hwId,
        proposalId: proposal.id,
        outcome: "proposed",
      });
    }
    return proposals;
  }

  private findMatches(claims: readonly IdentityClaim[], eligible: boolean): Set<string> {
    const matches = new Set<string>();
    for (const claim of claims) {
      const qualifies = claim.source.kind === "device_reported" || claim.source.kind === "independent_registry";
      if (qualifies !== eligible) continue;
      for (const hwId of this.claimIndex.get(claimKey(claim)) ?? []) matches.add(hwId);
    }
    return matches;
  }

  private indexClaims(hwId: string, claims: readonly IdentityClaim[]): void {
    for (const claim of claims) {
      const key = claimKey(claim);
      const ids = this.claimIndex.get(key) ?? new Set<string>();
      ids.add(hwId);
      this.claimIndex.set(key, ids);
    }
  }

  private createProposal(fields: Omit<GovernanceProposal, "id" | "status" | "createdAt" | "requiresHumanApproval">): GovernanceProposal {
    const proposal: GovernanceProposal = {
      ...fields,
      id: this.generatedId("proposal"),
      status: "proposed",
      createdAt: this.now(),
      requiresHumanApproval: true,
    };
    this.proposalsById.set(proposal.id, proposal);
    return proposal;
  }

  private recordAudit(fields: Omit<GovernanceAuditRecord, "id">): void {
    this.audit.push({ ...fields, id: this.generatedId("audit") });
  }

  private hubId(kind: "hw" | "hwCapability" | "hwSpace", material: string): string {
    if (this.idFactory !== undefined) return this.idFactory(kind);
    return stableOpaqueId(kind, material);
  }

  private generatedId(kind: "proposal" | "audit"): string {
    if (this.idFactory !== undefined) return this.idFactory(kind);
    const next = (this.counters.get(kind) ?? 0) + 1;
    this.counters.set(kind, next);
    return `${kind}-${next}`;
  }

  private takeRecentAudit(hwId: string, bridgeId: string | undefined, capabilities: readonly WorldCapability[]): GovernanceAuditRecord[] {
    return this.audit
      .filter((record) => record.hwId === hwId && (bridgeId === undefined || record.bridgeId === undefined || record.bridgeId === bridgeId))
      .filter((record) => record.kind === "identity-observed" || record.kind === "identity-auto-merged")
      .concat(this.audit.filter((record) => capabilities.some((capability) => record.hwCapabilityId === capability.hwCapabilityId)))
      .map((record) => ({ ...record }));
  }

  private requireIdentity(hwId: string): MutableIdentity {
    const identity = this.identities.get(hwId);
    if (identity === undefined) throw new WorldIdentityError(`Unknown hwId "${hwId}"`);
    return identity;
  }

  private requireCapability(hwCapabilityId: string): WorldCapability {
    const capability = this.capabilities.get(hwCapabilityId);
    if (capability === undefined) throw new WorldIdentityError(`Unknown hwCapabilityId "${hwCapabilityId}"`);
    return capability;
  }
}

export function claimSourceEligibleForAutoMerge(source: IdentityClaim["source"]): boolean {
  return source.kind === "device_reported" || source.kind === "independent_registry";
}

function hasConflictingMatches(eligible: Set<string>, ineligible: Set<string>): boolean {
  return [...ineligible].some((hwId) => !eligible.has(hwId));
}

function claimKey(claim: IdentityClaim): string {
  const source = claim.source.kind === "independent_registry"
    ? `${claim.source.kind}:${claim.source.registry}`
    : claim.source.kind === "platform_registry"
      ? `${claim.source.kind}:${claim.source.platform}`
      : claim.source.kind === "inferred"
        ? `${claim.source.kind}:${claim.source.method}`
        : claim.source.kind;
  return `${source}\u0000${claim.type}\u0000${claim.value}`;
}

function stableIdentityMaterial(
  bridgeId: string,
  nativeId: string,
  claims: readonly IdentityClaim[],
  allowEligibleClaimFingerprint: boolean,
): string {
  const eligibleClaims = allowEligibleClaimFingerprint
    ? claims
      .filter((claim) => claimSourceEligibleForAutoMerge(claim.source))
      .map(stableClaimKey)
      .sort(compare)
    : [];
  return eligibleClaims.length > 0
    ? JSON.stringify(["claims", eligibleClaims])
    : JSON.stringify(["native", bridgeId, nativeId]);
}

function stableClaimKey(claim: IdentityClaim): string {
  return JSON.stringify([claimKey(claim), claim.type, claim.value]);
}

function stableBindingKey(
  bridgeId: string,
  nativeId: string,
  ref: AdapterCapabilityRef,
): string {
  return JSON.stringify([bridgeId, nativeId, ref.nativeInstanceId, ref.schema]);
}

function stableOpaqueId(kind: "hw" | "hwCapability" | "hwSpace", material: string): string {
  const domain = kind === "hwCapability"
    ? "home-world/hw-capability/v1"
    : kind === "hwSpace" ? "home-world/hw-space/v1" : "home-world/hw/v1";
  const digest = createHash("sha256")
    .update(`${domain}\u0000${material}`, "utf8")
    .digest("hex");
  const prefix = kind === "hwCapability" ? "hwc" : kind === "hwSpace" ? "hws" : "hw";
  return `${prefix}-${digest}`;
}

function mergeClaims(existing: readonly IdentityClaim[], incoming: readonly IdentityClaim[]): IdentityClaim[] {
  const byKey = new Map(existing.map((claim) => [claimKey(claim), claim]));
  for (const claim of incoming) byKey.set(claimKey(claim), claim);
  return [...byKey.values()].map(cloneClaim);
}

function cloneClaims(claims: readonly IdentityClaim[]): IdentityClaim[] {
  return claims.map(cloneClaim);
}

function cloneClaim(claim: IdentityClaim): IdentityClaim {
  return {
    ...claim,
    source: { ...claim.source },
  } as IdentityClaim;
}

function cloneIdentity(identity: MutableIdentity): WorldIdentity {
  return { hwId: identity.hwId, claims: cloneClaims(identity.claims) };
}

function cloneCapability(capability: WorldCapability): WorldCapability {
  return { ...capability, bindings: capability.bindings.map((binding) => ({ ...binding })) };
}

function cloneSpace(space: WorldSpace): WorldSpace {
  return { ...space, bindings: space.bindings.map((binding) => ({ ...binding })) };
}

function requireText(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) throw new WorldIdentityError(`${name} is required`);
}

function normalizeTime(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
