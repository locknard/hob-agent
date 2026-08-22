import type {
  AutomationsExtension,
  BridgeActionTarget,
  BridgeAutomationStatusResult,
  BridgeAutomationAction,
  BridgeAutomationCondition,
  BridgeAutomationSpec,
  BridgeAutomationTrigger,
} from "@hob/bridge-contract";

import { parseArtifactContent } from "../artifact/neutral-artifact.js";
import type { ProposalDeploymentPort } from "./home-proposal-service.js";
import type { ProposalDeploymentIntent } from "./proposal-store.js";
import type { ProposalDeploymentOutcome } from "./proposal-store.js";

/**
 * The governed route from one household decision to a running ecosystem
 * automation. It compiles the approved neutral artifact into a bridge
 * automation spec with fully resolved bindings, deploys through the bridge's
 * automations extension, and reports household-readable outcomes. Reasons stay
 * neutral: no bridge-native payload or endpoint detail reaches the caller.
 */
export interface AutomationBridgeSource {
  automationBridgeForTargets(hwCapabilityIds: readonly string[]): {
    readonly bridgeId: string;
    readonly automations: AutomationsExtension;
    resolveTarget(hwCapabilityId: string): BridgeActionTarget | undefined;
  } | undefined;
  automationsHandleFor(bridgeId: string): AutomationsExtension | undefined;
}

const NO_BRIDGE_REASON = "这个家还没有可用的自动化部署通道，方案已保留，接通后可以重试。";

export class BridgeAutomationDeployment implements ProposalDeploymentPort {
  constructor(private readonly world: AutomationBridgeSource) {}

  /** Resolves the target domain and deterministic id without writing anything. */
  resolveIntent(request: {
    readonly proposalId: string;
    readonly kind: string;
    readonly artifactCandidate?: { readonly schemaVersion: "1"; readonly content: unknown };
  }): ProposalDeploymentIntent | { readonly reason: string } {
    if (request.kind !== "automation-draft" || request.artifactCandidate === undefined) {
      return { reason: "这条建议不包含可部署的自动化方案。" };
    }
    const capabilityIds = deviceCapabilityIdsOf(request.artifactCandidate.content);
    if (capabilityIds === undefined) {
      return { reason: "自动化方案的内容没有通过校验，家里的设置保持原样。" };
    }
    const bridge = this.world.automationBridgeForTargets(capabilityIds);
    if (bridge === undefined) return { reason: NO_BRIDGE_REASON };
    return { deploymentId: automationIdForProposal(request.proposalId), target: bridge.bridgeId };
  }

  async deploy(request: {
    readonly proposalId: string;
    readonly revision: number;
    readonly kind: string;
    readonly title: string;
    readonly artifactCandidate?: { readonly schemaVersion: "1"; readonly content: unknown };
  }): Promise<ProposalDeploymentOutcome> {
    if (request.kind !== "automation-draft" || request.artifactCandidate === undefined) {
      return { status: "failed", reason: "这条建议不包含可部署的自动化方案。" };
    }
    const capabilityIds = deviceCapabilityIdsOf(request.artifactCandidate.content);
    if (capabilityIds === undefined) {
      return { status: "failed", reason: "自动化方案的内容没有通过校验，家里的设置保持原样。" };
    }
    const bridge = this.world.automationBridgeForTargets(capabilityIds);
    if (bridge === undefined) return { status: "failed", reason: NO_BRIDGE_REASON };
    const spec = compileAutomationSpec(request.proposalId, request.title, request.artifactCandidate.content, bridge.resolveTarget);
    if ("reason" in spec) return { status: "failed", reason: spec.reason };
    const result = await bridge.automations.deploy(spec.value, { signal: AbortSignal.timeout(15_000) });
    if (result.status === "deployed") {
      return {
        status: "verified",
        deploymentId: result.nativeAutomationId,
        target: bridge.bridgeId,
      };
    }
    return { status: "failed", reason: deployRejectionReason(result.reason) };
  }

  /** Asks the target bridge whether the deployed automation actually runs. */
  async status(request: { readonly deploymentId: string; readonly target: string }): Promise<BridgeAutomationStatusResult["status"]> {
    const automations = this.world.automationsHandleFor(request.target);
    if (automations === undefined) return "unknown";
    try {
      const result = await automations.status(
        { nativeAutomationId: request.deploymentId },
        { signal: AbortSignal.timeout(10_000) },
      );
      return result.status;
    } catch {
      return "unknown";
    }
  }

  async pause(request: { readonly proposalId: string; readonly deploymentId?: string; readonly target?: string }): Promise<void> {
    await this.toggle(request, false);
  }

  async resume(request: { readonly proposalId: string; readonly deploymentId?: string; readonly target?: string }): Promise<void> {
    await this.toggle(request, true);
  }

  async withdraw(request: { readonly proposalId: string; readonly deploymentId: string; readonly target?: string }): Promise<{ readonly restored: boolean }> {
    const automations = request.target === undefined ? undefined : this.world.automationsHandleFor(request.target);
    if (automations === undefined) return { restored: false };
    const result = await automations.withdraw(
      { nativeAutomationId: request.deploymentId },
      { signal: AbortSignal.timeout(15_000) },
    );
    // The Hub only ever deploys its own automations, so removal restores the
    // home to exactly the configuration it had before enablement.
    return { restored: result.status === "acknowledged" };
  }

  private async toggle(
    request: { readonly deploymentId?: string; readonly target?: string },
    enabled: boolean,
  ): Promise<void> {
    if (request.deploymentId === undefined) return;
    const automations = request.target === undefined ? undefined : this.world.automationsHandleFor(request.target);
    if (automations === undefined) throw new Error("automation_bridge_unavailable");
    const result = await automations.setEnabled(
      { nativeAutomationId: request.deploymentId, enabled },
      { signal: AbortSignal.timeout(15_000) },
    );
    if (result.status !== "acknowledged") throw new Error("automation_toggle_rejected");
  }
}

/** Device capability ids referenced by the plan; undefined when it cannot parse. */
function deviceCapabilityIdsOf(content: unknown): readonly string[] | undefined {
  let parsed: ReturnType<typeof parseArtifactContent>;
  try {
    parsed = parseArtifactContent(content);
  } catch {
    return undefined;
  }
  const ids = new Set<string>();
  if (parsed.trigger.kind === "capability_changed") ids.add(parsed.trigger.source.hwCapabilityId);
  for (const condition of parsed.conditions) ids.add(condition.source.hwCapabilityId);
  for (const action of parsed.actions) {
    if (action.kind !== "notify_local") ids.add(action.target.hwCapabilityId);
  }
  return [...ids];
}

/** Stable, adapter-safe automation identity derived from the proposal id. */
export function automationIdForProposal(proposalId: string): string {
  const sanitized = proposalId.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return `hob_${sanitized}`.slice(0, 120);
}

function compileAutomationSpec(
  proposalId: string,
  title: string,
  content: unknown,
  resolveTarget: (hwCapabilityId: string) => BridgeActionTarget | undefined,
): { readonly value: BridgeAutomationSpec } | { readonly reason: string } {
  let parsed: ReturnType<typeof parseArtifactContent>;
  try {
    parsed = parseArtifactContent(content);
  } catch {
    return { reason: "自动化方案的内容没有通过校验，家里的设置保持原样。" };
  }
  const resolveOrFail = (hwCapabilityId: string): BridgeActionTarget | { readonly reason: string } => {
    const target = resolveTarget(hwCapabilityId);
    return target ?? { reason: "方案里有设备现在无法定位，家里的设置保持原样。" };
  };
  let trigger: BridgeAutomationTrigger;
  if (parsed.trigger.kind === "schedule") {
    trigger = {
      kind: "schedule",
      timezone: parsed.trigger.timezone,
      daysOfWeek: [...parsed.trigger.daysOfWeek],
      at: parsed.trigger.at,
    };
  } else {
    const source = resolveOrFail(parsed.trigger.source.hwCapabilityId);
    if ("reason" in source) return source;
    trigger = { kind: "capability_changed", source };
  }
  const conditions: BridgeAutomationCondition[] = [];
  for (const condition of parsed.conditions) {
    const source = resolveOrFail(condition.source.hwCapabilityId);
    if ("reason" in source) return source;
    conditions.push({ kind: "capability_value", source, operator: condition.operator, value: condition.value });
  }
  const actions: BridgeAutomationAction[] = [];
  for (const action of parsed.actions) {
    if (action.kind === "notify_local") {
      actions.push({ kind: "notify_local", message: action.message });
      continue;
    }
    const target = resolveOrFail(action.target.hwCapabilityId);
    if ("reason" in target) return target;
    actions.push(action.kind === "set_boolean"
      ? { kind: "set_boolean", target, value: action.value }
      : { kind: "set_level", target, level: action.value });
  }
  return {
    value: {
      automationId: automationIdForProposal(proposalId),
      title,
      trigger,
      conditions,
      actions,
    },
  };
}

function deployRejectionReason(reason: "unsupported" | "invalid_target" | "unavailable" | "failed"): string {
  switch (reason) {
    case "unsupported": return "家里的设备暂不支持这种自动化动作，家里的设置保持原样。";
    case "invalid_target": return "方案里有设备现在无法定位，家里的设置保持原样。";
    case "unavailable": return "家庭连接暂时不可用，方案已保留，恢复后可以重试。";
    case "failed": return "部署没有完成，家里的设置保持原样。";
  }
}
