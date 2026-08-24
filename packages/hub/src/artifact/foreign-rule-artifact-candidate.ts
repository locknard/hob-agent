import {
  bridgeActionTargetSchema,
  foreignRuleMigrationResultSchema,
  type BridgeActionTarget,
  type ForeignRuleMigrationBinding,
  type ForeignRuleMigrationResult,
  type ForeignRuleMigrationTrigger,
} from "@hob/bridge-contract";
import {
  parseArtifactContent,
  type ArtifactAction,
  type ArtifactCondition,
  type ArtifactContent,
  type ArtifactTrigger,
} from "./neutral-artifact.js";

/** The bounded review-time constants used for the first reversible migration slice. */
export const FOREIGN_RULE_ARTIFACT_ROLLBACK_MAX_AGE_SECONDS = 900;
export const FOREIGN_RULE_ARTIFACT_POSTCONDITION_WITHIN_SECONDS = 60;

const foreignRuleArtifactCandidateAttentionReasons = [
  "invalid_input",
  "resolver_failed",
  "unbound_target",
  "multiple_targets",
  "invalid_title",
  "artifact_invalid",
] as const;

export type ForeignRuleArtifactCandidateAttentionReason =
  typeof foreignRuleArtifactCandidateAttentionReasons[number];

export type ForeignRuleArtifactTargetResolver =
  (binding: ForeignRuleMigrationBinding) => BridgeActionTarget | undefined;

export type ForeignRuleArtifactCandidate = {
  readonly status: "candidate";
  readonly sourceFingerprint: string;
  readonly ruleRef: string;
  readonly title: string;
  readonly content: ArtifactContent;
};

export type ForeignRuleArtifactNeedsAttention = {
  readonly status: "needs_attention";
  readonly reason: ForeignRuleArtifactCandidateAttentionReason;
};

export type ForeignRuleArtifactCandidateResult =
  | ForeignRuleArtifactCandidate
  | ForeignRuleArtifactNeedsAttention;

type ResolvedTarget = { readonly hwCapabilityId: string };

/**
 * Converts one contract-validated foreign rule into a review-only neutral
 * Artifact content candidate. This function never reads a bridge or performs
 * a write; the resolver is the only route from a bridge binding to a neutral
 * capability identity.
 */
export function createForeignRuleArtifactCandidate(
  input: unknown,
  resolveTarget: ForeignRuleArtifactTargetResolver,
): ForeignRuleArtifactCandidateResult {
  let parsed: ForeignRuleMigrationResult;
  try {
    const result = foreignRuleMigrationResultSchema.safeParse(input);
    if (!result.success || result.data.status !== "translated") {
      return needsAttention("invalid_input");
    }
    parsed = result.data;
  } catch {
    return needsAttention("invalid_input");
  }

  if (typeof resolveTarget !== "function") {
    return needsAttention("invalid_input");
  }
  if (!isArtifactTitle(parsed.title)) {
    return needsAttention("invalid_title");
  }

  try {
    const triggerResult = mapTrigger(parsed.plan.trigger, resolveTarget);
    if (triggerResult.status !== "ok") return triggerResult;

    const conditions: ArtifactCondition[] = [];
    for (const condition of parsed.plan.conditions) {
      const source = resolveBinding(condition.source, resolveTarget);
      if (source.status !== "ok") return source;
      conditions.push({
        kind: "capability_value",
        source: { hwCapabilityId: source.target.hwCapabilityId },
        operator: condition.operator,
        value: condition.value,
      });
    }

    const actions: ArtifactAction[] = [];
    for (const action of parsed.plan.actions) {
      if (action.kind === "notify_local") {
        actions.push({ kind: "notify_local", message: action.message });
        continue;
      }

      const target = resolveBinding(action.target, resolveTarget);
      if (target.status !== "ok") return target;
      if (action.kind === "set_boolean") {
        actions.push({
          kind: "set_boolean",
          target: { hwCapabilityId: target.target.hwCapabilityId },
          value: action.value,
        });
      } else {
        actions.push({
          kind: "set_level",
          target: { hwCapabilityId: target.target.hwCapabilityId },
          value: action.level,
        });
      }
    }

    const deviceActions = actions.filter(isDeviceAction);
    const deviceTargetIds = new Set(deviceActions.map((action) => action.target.hwCapabilityId));
    if (deviceTargetIds.size > 1) {
      return needsAttention("multiple_targets");
    }

    const deviceTarget = deviceActions[0]?.target;
    const content: unknown = {
      trigger: triggerResult.trigger,
      conditions,
      actions,
      rollback: deviceTarget === undefined
        ? { kind: "no_remote_change" }
        : {
          kind: "restore_previous_state",
          target: deviceTarget,
          maxAgeSeconds: FOREIGN_RULE_ARTIFACT_ROLLBACK_MAX_AGE_SECONDS,
        },
      postconditions: deviceTarget === undefined
        ? []
        : [createDevicePostcondition(deviceActions[deviceActions.length - 1]!)],
    };

    let parsedContent: ArtifactContent;
    try {
      parsedContent = parseArtifactContent(content);
    } catch {
      return needsAttention("artifact_invalid");
    }

    return Object.freeze({
      status: "candidate" as const,
      sourceFingerprint: parsed.sourceFingerprint,
      ruleRef: parsed.ruleRef,
      title: parsed.title,
      content: parsedContent,
    });
  } catch {
    // Provider objects and resolver implementations are untrusted. No error
    // object or provider detail crosses the candidate boundary.
    return needsAttention("resolver_failed");
  }
}

/** Descriptive alias for callers that name the operation after its source. */
export const translateForeignRuleToArtifactCandidate = createForeignRuleArtifactCandidate;

function mapTrigger(
  trigger: ForeignRuleMigrationTrigger,
  resolveTarget: ForeignRuleArtifactTargetResolver,
): { readonly status: "ok"; readonly trigger: ArtifactTrigger } | ForeignRuleArtifactNeedsAttention {
  if (trigger.kind === "schedule") {
    return {
      status: "ok",
      trigger: {
        kind: "schedule",
        timezone: trigger.timezone,
        daysOfWeek: trigger.daysOfWeek,
        at: trigger.at,
      },
    };
  }

  const source = resolveBinding(trigger.source, resolveTarget);
  if (source.status !== "ok") return source;
  return {
    status: "ok",
    trigger: {
      kind: "capability_changed",
      source: { hwCapabilityId: source.target.hwCapabilityId },
    },
  };
}

function resolveBinding(
  binding: ForeignRuleMigrationBinding,
  resolveTarget: ForeignRuleArtifactTargetResolver,
): { readonly status: "ok"; readonly target: ResolvedTarget } | ForeignRuleArtifactNeedsAttention {
  let resolved: BridgeActionTarget | undefined;
  try {
    resolved = resolveTarget(binding);
  } catch {
    return needsAttention("resolver_failed");
  }
  if (resolved === undefined) return needsAttention("unbound_target");

  try {
    const parsed = bridgeActionTargetSchema.safeParse(resolved);
    if (!parsed.success) return needsAttention("resolver_failed");
    if (parsed.data.binding.bridgeId !== binding.bridgeId
      || parsed.data.binding.nativeId !== binding.nativeId
      || parsed.data.binding.nativeInstanceId !== binding.nativeInstanceId) {
      return needsAttention("resolver_failed");
    }
    return { status: "ok", target: { hwCapabilityId: parsed.data.hwCapabilityId } };
  } catch {
    return needsAttention("resolver_failed");
  }
}

function createDevicePostcondition(action: Exclude<ArtifactAction, { kind: "notify_local" }>) {
  return {
    kind: "capability_value" as const,
    source: { hwCapabilityId: action.target.hwCapabilityId },
    operator: "equals" as const,
    value: action.value,
    withinSeconds: FOREIGN_RULE_ARTIFACT_POSTCONDITION_WITHIN_SECONDS,
  };
}

function isDeviceAction(action: ArtifactAction): action is Exclude<ArtifactAction, { kind: "notify_local" }> {
  return action.kind === "set_boolean" || action.kind === "set_level";
}

function isArtifactTitle(value: string): boolean {
  return value.length > 0
    && value.length <= 120
    && value === value.trim()
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function needsAttention(reason: ForeignRuleArtifactCandidateAttentionReason): ForeignRuleArtifactNeedsAttention {
  return Object.freeze({ status: "needs_attention" as const, reason });
}
