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
import type { ProposalDeploymentIntent, ProposalDeploymentTargetBinding } from "./proposal-store.js";
import type { ProposalDeploymentOutcome } from "./proposal-store.js";

/**
 * The governed route from one household decision to a running ecosystem
 * automation. It compiles the approved neutral artifact into a bridge
 * automation spec with fully resolved bindings, deploys through the bridge's
 * automations extension, and reports household-readable outcomes. Reasons stay
 * neutral: no bridge-native payload or endpoint detail reaches the caller.
 */
export interface AutomationBridgeSource {
  resolveActionAuthority(hwCapabilityId: string):
    | { readonly status: "available"; readonly bridgeId?: string; readonly policyClass: "direct" | "confirmation" | "administrator" }
    | { readonly status: "unavailable"; readonly reason: "not_configured" | "not_approved" | "configured_binding_unavailable" | "unknown_capability" };
  capabilityDeviceName(hwCapabilityId: string): string | undefined;
  automationBridgeForTargets(hwCapabilityIds: readonly string[]): {
    readonly bridgeId: string;
    readonly automations: AutomationsExtension;
    resolveTarget(hwCapabilityId: string): BridgeActionTarget | undefined;
  } | undefined;
  automationsHandleFor(bridgeId: string): AutomationsExtension | undefined;
  automationBridgeById(bridgeId: string): {
    readonly bridgeId: string;
    readonly automations: AutomationsExtension;
    resolveTarget(hwCapabilityId: string): BridgeActionTarget | undefined;
  } | undefined;
}

const NO_BRIDGE_REASON = "这个家还没有可用的自动化部署通道，方案已保留，接通后可以重试。";

export class BridgeAutomationDeployment implements ProposalDeploymentPort {
  constructor(private readonly world: AutomationBridgeSource) {}

  /** Resolves the target domain and deterministic id without writing anything. */
  resolveIntent(request: {
    readonly proposalId: string;
    readonly kind: string;
    readonly artifactCandidate?: { readonly schemaVersion: "1"; readonly content: unknown };
    readonly actionPolicyClasses?: readonly string[];
    readonly confirmationDeviceNames?: readonly string[];
  }): ProposalDeploymentIntent
    | { readonly reason: string }
    | { readonly revalidationReason: string; readonly updatedGateDisclosure?: { readonly actionPolicyClasses: readonly ("direct" | "confirmation")[]; readonly confirmationDeviceNames?: readonly string[] } }
    | { readonly blockedReason: string } {
    if (request.kind !== "automation-draft" || request.artifactCandidate === undefined) {
      return { reason: "这条建议不包含可部署的自动化方案。" };
    }
    let parsed: ReturnType<typeof parseArtifactContent>;
    try {
      parsed = parseArtifactContent(request.artifactCandidate.content);
    } catch {
      return { reason: "自动化方案的内容没有通过校验，家里的设置保持原样。" };
    }
    const capabilityIds = deviceCapabilityIdsOf(request.artifactCandidate.content);
    if (capabilityIds === undefined) {
      return { reason: "自动化方案的内容没有通过校验，家里的设置保持原样。" };
    }
    const bridge = this.world.automationBridgeForTargets(capabilityIds);
    if (bridge === undefined) return { reason: NO_BRIDGE_REASON };
    const targets: ProposalDeploymentTargetBinding[] = [];
    for (const hwCapabilityId of capabilityIds) {
      const target = bridge.resolveTarget(hwCapabilityId);
      if (target === undefined) return { reason: "方案里有设备现在无法定位，家里的设置保持原样。" };
      targets.push(target);
    }
    // The world may have changed since preparation. An action that is no
    // longer automatable blocks honestly; a gate-class shift re-prepares once
    // with the refreshed disclosure so the loop always converges.
    const recomputed = new Set<"direct" | "confirmation">();
    const confirmationNames = new Set<string>();
    for (const action of parsed.actions) {
      if (action.kind === "notify_local") continue;
      const authority = this.world.resolveActionAuthority(action.target.hwCapabilityId);
      if (authority.status !== "available") {
        // The authority names why. Each cause routes to a VISIBLE state that
        // can recover from it: retrying never fixes a configuration gap, and
        // a silent re-preparation would make the card vanish from the list.
        switch (authority.reason) {
          case "unknown_capability":
            return { blockedReason: "方案里的设备已经不在家庭地图里，不能再交给自动化。可以在对话里改方案，或不用了。" };
          case "not_configured":
            return { blockedReason: "方案里设备的确认方式还没有设置好，先在设置里为它选择确认方式；也可以在对话里改方案，或不用了。" };
          case "not_approved":
            return { blockedReason: "家庭已撤回这个设备动作的授权，暂时不能交给自动化。可以在对话里改方案，或不用了。" };
          case "configured_binding_unavailable":
            return { reason: "方案里有设备现在暂时连不上，家里的设置保持原样；稍后再试一次就好。" };
          default:
            // Out-of-contract adapters land here at runtime: commit to nothing.
            return { reason: "方案里设备的执行权限暂时无法确认，家里的设置保持原样；稍后再试一次。" };
        }
      }
      if (authority.policyClass === "administrator") {
        // Protected escalation is a standing household fact: the plan blocks
        // honestly until the household revises or declines it.
        return { blockedReason: "方案里有设备的动作已进入高影响保护，暂时不能交给自动化。可以在对话里改方案，或不用了。" };
      }
      const gateClass = authority.policyClass === "confirmation" ? "confirmation" as const : "direct" as const;
      recomputed.add(gateClass);
      if (gateClass === "confirmation") {
        const name = this.world.capabilityDeviceName(action.target.hwCapabilityId);
        if (name === undefined) {
          // Dropping the name would make the disclosure sets agree by
          // under-disclosing; the honest outcome is a retryable map defect.
          return { reason: "方案里需要确认的设备现在没有可读名称，请先在家庭地图里补全设备名称，再试一次。" };
        }
        confirmationNames.add(name);
      }
    }
    // The household approved a disclosure: the gate-class set AND the named
    // devices that require confirmation. Either fact changing re-prepares.
    const recordedClasses = [...new Set(request.actionPolicyClasses ?? [])].sort().join(",");
    const observedClasses = [...recomputed].sort().join(",");
    const recordedNames = [...new Set(request.confirmationDeviceNames ?? [])].sort().join("\u0000");
    const observedNames = [...confirmationNames].sort().join("\u0000");
    if (recordedClasses !== observedClasses || recordedNames !== observedNames) {
      return {
        revalidationReason: recordedClasses !== observedClasses
          ? "方案里设备的确认档位已变化，需要重新准备并更新说明。"
          : "方案里需要确认的设备已变化，需要重新准备并更新说明。",
        updatedGateDisclosure: {
          actionPolicyClasses: [...recomputed].sort(),
          ...(confirmationNames.size === 0 ? {} : { confirmationDeviceNames: [...confirmationNames].sort() }),
        },
      };
    }
    return { deploymentId: automationIdForProposal(request.proposalId), target: bridge.bridgeId, targets };
  }

  async deploy(request: {
    readonly proposalId: string;
    readonly revision: number;
    readonly kind: string;
    readonly title: string;
    readonly artifactCandidate?: { readonly schemaVersion: "1"; readonly content: unknown };
    readonly intent: ProposalDeploymentIntent;
  }): Promise<ProposalDeploymentOutcome> {
    if (request.kind !== "automation-draft" || request.artifactCandidate === undefined) {
      return { status: "failed", reason: "这条建议不包含可部署的自动化方案。" };
    }
    // Initial enablement, retry and crash recovery all walk one path: the
    // persisted intent decides the target domain and the native id.
    const bridge = this.world.automationBridgeById(request.intent.target);
    if (bridge === undefined) return { status: "failed", reason: NO_BRIDGE_REASON };
    // The intent's capability set and the compiled plan's capability set are
    // one authorization: any mismatch means the plan changed after the
    // decision, and the deployment fails closed.
    const planCapabilityIds = deviceCapabilityIdsOf(request.artifactCandidate.content);
    if (planCapabilityIds === undefined
      || planCapabilityIds.length !== request.intent.targets.length
      || !planCapabilityIds.every((id) => request.intent.targets.some((target) => target.hwCapabilityId === id))) {
      return { status: "failed", reason: "方案内容与批准时的意图不一致，家里的设置保持原样。" };
    }
    // The authorized binding vector is the deployment's contract: a device that
    // re-bound since the decision fails closed instead of being followed.
    for (const authorized of request.intent.targets) {
      const currentTarget = bridge.resolveTarget(authorized.hwCapabilityId);
      if (currentTarget === undefined
        || currentTarget.binding.bridgeId !== authorized.binding.bridgeId
        || currentTarget.binding.nativeId !== authorized.binding.nativeId
        || currentTarget.binding.nativeInstanceId !== authorized.binding.nativeInstanceId) {
        return { status: "failed", reason: "设备的接入方式在批准后发生了变化，家里的设置保持原样；重新准备后再启用。" };
      }
    }
    const spec = compileAutomationSpec(request.proposalId, request.title, request.artifactCandidate.content, bridge.resolveTarget);
    if ("reason" in spec) return { status: "failed", reason: spec.reason };
    if (spec.value.automationId !== request.intent.deploymentId) {
      return { status: "failed", reason: "部署身份与批准时的意图不一致，家里的设置保持原样。" };
    }
    const result = await bridge.automations.deploy(spec.value, { signal: AbortSignal.timeout(15_000) });
    if (result.status === "deployed") {
      return {
        status: "verified",
        deploymentId: result.nativeAutomationId,
        target: bridge.bridgeId,
        ...(result.configFingerprint === undefined ? {} : { configFingerprint: result.configFingerprint }),
      };
    }
    return { status: "failed", reason: deployRejectionReason(result.reason) };
  }

  /** Asks the target bridge whether the deployed automation actually runs. */
  async status(request: { readonly deploymentId: string; readonly target: string }): Promise<BridgeAutomationStatusResult> {
    const automations = this.world.automationsHandleFor(request.target);
    if (automations === undefined) return { status: "unknown" };
    try {
      return await automations.status(
        { nativeAutomationId: request.deploymentId },
        { signal: AbortSignal.timeout(10_000) },
      );
    } catch {
      return { status: "unknown" };
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
