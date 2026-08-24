import {
  foreignRuleMigrationResultSchema,
  type ForeignRuleMigrationResult,
} from "@hob/bridge-contract";

import type {
  HomeAutomationMigrationRuleAnalysis,
  HomeAutomationMigrationTranslator as HomeAutomationMigrationTranslatorPort,
  HomeAutomationMigrationTranslatorRequest,
} from "./home-automation-migration-service.js";

/**
 * The only HomeWorld capability needed by migration assessment.  The shape is
 * intentionally structural so a HomeWorldService instance can be injected
 * without exposing its wider runtime surface to the assessment.
 */
export interface HomeAutomationMigrationWorldPort {
  translateForeignRule(input: HomeAutomationMigrationWorldRequest): Promise<unknown>;
}
export interface HomeAutomationMigrationWorldRequest {
  readonly bridgeId: string;
  readonly epochId: string;
  readonly lastSeq: number;
  readonly ruleRef: string;
  readonly signal: AbortSignal;
}

/**
 * Adapts one bounded HomeWorld translation into assessment-only classes.
 * Native plans, bindings, watermarks, and provider reasons end at this
 * boundary; a failed or untrusted translation is represented by `undefined`.
 */
export class HomeAutomationMigrationTranslator implements HomeAutomationMigrationTranslatorPort {
  constructor(private readonly world: HomeAutomationMigrationWorldPort) {}

  async assess(
    request: HomeAutomationMigrationTranslatorRequest,
    options: { readonly signal: AbortSignal },
  ): Promise<HomeAutomationMigrationRuleAnalysis | undefined> {
    try {
      const bridgeId = request.bridgeId;
      const epochId = request.epochId;
      const lastSeq = request.lastSeq;
      const ruleRef = request.ruleRef;
      const signal = options.signal;

      const result = await this.world.translateForeignRule({
        bridgeId,
        epochId,
        lastSeq,
        ruleRef,
        signal,
      });

      // The HomeWorld port is trusted in-process, but its adapter result is
      // still an external/bridge-derived value and must cross the contract a
      // second time before assessment reads any field from it.
      if (signal.aborted) return undefined;
      const parsed = foreignRuleMigrationResultSchema.safeParse(result);
      if (!parsed.success) return undefined;
      return mapContractResult(parsed.data, ruleRef);
    } catch {
      // Provider errors, throwing getters, proxies, malformed ports, and
      // cancellation are all recoverable assessment failures.  Their details
      // never enter the household-facing assessment.
      return undefined;
    }
  }
}

function mapContractResult(
  result: ForeignRuleMigrationResult,
  requestedRuleRef: string,
): HomeAutomationMigrationRuleAnalysis | undefined {
  if (result.status === "translated") {
    if (result.ruleRef !== requestedRuleRef) return undefined;

    const trigger = result.plan.trigger.kind === "schedule"
      ? { kind: "time" as const }
      : result.plan.trigger.kind === "capability_changed"
        ? { kind: "state" as const }
        : undefined;
    if (trigger === undefined) return undefined;

    // The contract limits actions to reversible device actions and local
    // notifications.  A notification-only plan therefore remains supported
    // and is classified as reversible; Artifact later records no_remote_change.
    return Object.freeze({
      ruleRef: requestedRuleRef,
      sourceFingerprint: result.sourceFingerprint,
      trigger: Object.freeze(trigger),
      condition: Object.freeze({ kind: "flat_and" as const }),
      action: Object.freeze({ kind: "reversible" as const }),
    });
  }

  if (result.status !== "unsupported") return undefined;

  if (result.reason === "multiple_triggers" || result.reason === "unsupported_trigger") {
    return analysis(requestedRuleRef, "unsupported", "unknown", "unknown");
  }
  if (result.reason === "unsupported_condition") {
    return analysis(requestedRuleRef, "unknown", "unsupported", "unknown");
  }
  if (result.reason === "unsupported_action"
    || result.reason === "multiple_targets"
    || result.reason === "mode_not_single"
    || result.reason === "unsupported_structure") {
    return analysis(requestedRuleRef, "unknown", "unknown", "unsupported");
  }

  // unknown_rule and unbound_target are intentionally not assessment
  // classifications.  They indicate that the source cannot be safely
  // interpreted and therefore enter needs_attention through the service.
  return undefined;
}

function analysis(
  ruleRef: string,
  trigger: "state" | "time" | "unsupported" | "unknown",
  condition: "flat_and" | "unsupported" | "unknown",
  action: "reversible" | "unsupported" | "unknown",
): HomeAutomationMigrationRuleAnalysis {
  return Object.freeze({
    ruleRef,
    trigger: Object.freeze({ kind: trigger }),
    condition: Object.freeze({ kind: condition }),
    action: Object.freeze({ kind: action }),
  });
}
