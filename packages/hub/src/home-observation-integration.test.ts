import assert from "node:assert/strict";
import test from "node:test";

import { Context, Service } from "@deepseek-ai/cordis";
import { DshHomeAgentService } from "@hob-agent/agent-layer/home-agent";
import { ProposalInboxService } from "@hob-agent/inbox-web/service";

import { HomeAdviceService } from "./home-advice-service.js";
import { HomeProposalService } from "./home-proposal-service.js";

class AcceptanceWorld extends Service {
  constructor(ctx: Context) {
    super(ctx, "homeWorld");
  }

  snapshot() {
    return {
      generatedAt: "2026-08-19T04:00:00.000Z",
      spaces: [{
        hwSpaceId: "hws-1",
        name: "Shared space",
        bindings: [{ bridgeId: "bridge-a", nativeSpaceId: "space-a" }],
      }],
      bridges: { "bridge-a": { diagnostics: { historyGapCount: 0 } } },
      bridgeWatermarks: [{ bridgeId: "bridge-a", epochId: "epoch-a", lastSeq: 8 }],
      diagnostics: [{ bridgeId: "bridge-a", connectionState: "ready" as const, historyGapCount: 0, currentProcessReadyAt: "2026-08-19T03:59:00.000Z" }],
      devices: [{
        hwId: "hw-1",
        bindings: [{
          bridgeId: "bridge-a",
          nativeId: "native-1",
          nativeInstanceId: "instance-1",
          hwSpaceId: "hws-1",
        }],
        name: "Observed device",
        validity: "valid" as const,
        capabilities: [{
          hwCapabilityId: "hwc-1",
          hwId: "hw-1",
          schema: "hob.light",
          schemaVersion: "1.0.0",
          semanticKind: "light" as const,
          bindings: [{
            bridgeId: "bridge-a",
            nativeId: "native-1",
            nativeInstanceId: "instance-1",
            hwSpaceId: "hws-1",
          }],
        }],
        states: [{
          nativeId: "native-1",
          nativeInstanceId: "instance-1",
          attrs: { state: "on" },
          time: { sourceTs: "2026-08-19T03:59:00.000Z", sourceTsQuality: "platform" as const },
          origin: "observed" as const,
        }],
      }],
    };
  }

  queryRecentEvidence() {
    return {
      requestedSince: "2026-08-18T04:00:00.000Z",
      requestedUntil: "2026-08-19T04:00:00.000Z",
      events: [{
        hwId: "hw-1",
        hwCapabilityId: "hwc-1",
        semanticKind: "light" as const,
        value: "on",
        observedAt: "2026-08-19T03:30:00.000Z",
        sourceTsQuality: "platform" as const,
        origin: "observed" as const,
        provenance: { bridgeId: "bridge-a", epochId: "epoch-a", seq: 11 },
      }],
      coverage: [{
        bridgeId: "bridge-a",
        epochId: "epoch-a",
        baselineSeq: 8,
        baselineAt: "2026-08-18T04:00:00.000Z",
        status: "complete" as const,
        reasons: [],
      }],
      truncated: false,
    };
  }

  queryRecentActivity() {
    return {
      requestedSince: "2026-08-18T04:00:00.000Z",
      requestedUntil: "2026-08-19T04:00:00.000Z",
      devices: [{
        hwId: "hw-1",
        eventCount: 1,
        latestObservedAt: "2026-08-19T03:30:00.000Z",
        semanticKinds: ["light" as const],
      }],
      coverage: [{
        bridgeId: "bridge-a",
        epochId: "epoch-a",
        baselineSeq: 8,
        baselineAt: "2026-08-18T04:00:00.000Z",
        status: "complete" as const,
        reasons: [],
      }],
      truncated: false,
    };
  }

  async foreignRuleCatalog() {
    return [{
      bridgeId: "bridge-a",
      status: "available" as const,
      epochId: "epoch-a",
      rules: [{ ruleRef: "opaque-rule-1", name: "Existing light schedule", enabled: true }],
    }];
  }
}

class ObservationScriptAdapter {
  requests: unknown[] = [];

  providerInfo(provider: string) {
    return { id: provider, name: provider };
  }

  providerRetryPolicy() {
    return undefined;
  }

  async listModels() {
    return [];
  }

  async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model };
  }

  async *stream(options: unknown) {
    this.requests.push(options);
    const step = this.requests.length;
    if (step === 1) {
      yield* toolCall("call-skill", "skill", { name: "review-home-observation" });
      return;
    }
    if (step === 2) {
      yield* toolCall("call-calibration", "get_home_calibration", {});
      return;
    }
    if (step === 3) {
      yield* toolCall("call-inventory", "get_home_inventory", { limit: 50 });
      return;
    }
    if (step === 4) {
      yield* toolCall("call-activity", "get_home_activity", { lookbackHours: 24, limit: 20 });
      return;
    }
    if (step === 5) {
      yield* toolCall("call-snapshot", "get_home_snapshot", { semanticKinds: ["light"], limit: 10 });
      return;
    }
    if (step === 6) {
      yield* toolCall("call-evidence", "get_home_evidence", {
        hwCapabilityIds: ["hwc-1"],
        lookbackHours: 24,
        limit: 50,
      });
      return;
    }
    if (step === 7) {
      yield* toolCall("call-rules", "get_home_rules", { limit: 20 });
      return;
    }
    if (step === 8) {
      yield* toolCall("call-proposal", "create_home_proposal", {
        kind: "automation-draft",
        title: "Review repeated light activity",
        summary: "A bounded observed light event may warrant household review.",
        householdValue: "Reduce unnecessary repeated lighting while preserving household comfort.",
        whyNow: "A post-baseline event is available with complete temporal coverage.",
        uncertainties: ["Whether the observed light activity was intentional."],
        idempotencyKey: "acceptance:light-activity:v1",
        selectedHwIds: ["hw-1"],
        selectedHwCapabilityIds: ["hwc-1"],
        evidenceLookbackHours: 24,
        riskLevel: "low",
        riskReasons: ["Observation may not represent household intent"],
        intentDescription: "Review the observation without applying any automation.",
        rollback: "Reject the proposal.",
        artifactCandidate: {
          schemaVersion: "1",
          content: {
            trigger: {
              kind: "capability_changed",
              source: { hwCapabilityId: "hwc-1" },
            },
            conditions: [],
            actions: [{
              kind: "set_boolean",
              target: { hwCapabilityId: "hwc-1" },
              value: false,
            }],
            rollback: {
              kind: "restore_previous_state",
              target: { hwCapabilityId: "hwc-1" },
              maxAgeSeconds: 3600,
            },
            postconditions: [{
              kind: "capability_value",
              source: { hwCapabilityId: "hwc-1" },
              operator: "equals",
              value: false,
              withinSeconds: 30,
            }],
          },
        },
      });
      return;
    }
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text: "One review item was created." };
    yield { type: "block-end", index: 0, block: { type: "text", text: "One review item was created." } };
    yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}

class AdviceScriptAdapter extends ObservationScriptAdapter {
  override async *stream(options: unknown) {
    this.requests.push(options);
    const step = this.requests.length;
    if (step === 1) {
      yield* toolCall("call-advice-skill", "skill", { name: "answer-home-question" });
      return;
    }
    if (step === 2) {
      yield* toolCall("call-advice-calibration", "get_home_calibration", {});
      return;
    }
    if (step === 3) {
      yield* toolCall("call-advice-inventory", "get_home_inventory", { limit: 50 });
      return;
    }
    if (step === 4) {
      yield* toolCall("call-advice-activity", "get_home_activity", { lookbackHours: 24, limit: 20 });
      return;
    }
    if (step === 5) {
      yield* toolCall("call-advice-snapshot", "get_home_snapshot", { hwIds: ["hw-1"], limit: 10 });
      return;
    }
    if (step === 6) {
      yield* toolCall("call-advice-evidence", "get_home_evidence", {
        hwCapabilityIds: ["hwc-1"],
        lookbackHours: 24,
        limit: 50,
      });
      return;
    }
    if (step === 7) {
      yield* toolCall("call-advice-rules", "get_home_rules", { limit: 20 });
      return;
    }
    if (step === 8) {
      yield* toolCall("call-advice-report", "report_home_advice", {
        summary: "Try a daylight-aware window before changing hardware.",
        confidence: "partial",
        findings: ["The available household evidence does not explain changing daylight."],
        unknowns: ["Indoor brightness is not currently observed."],
        trial: {
          description: "Use sunrise with bounded earliest and latest opening times.",
          durationDays: 14,
          successCriteria: ["Fewer manual curtain reversals within 30 minutes."],
          rollback: "Restore the current fixed schedule.",
        },
        hardwareSuggestions: [{
          capability: "illuminance",
          necessity: "optional",
          reason: "It can distinguish dark mornings from bright mornings.",
          placement: "Near the window but outside direct glare.",
          privacyImpact: "low",
          alternative: "Use sunrise and weather data first.",
        }],
        validationSteps: ["Review manual reversals after two weeks."],
      });
      return;
    }
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text: "The advice report is ready." };
    yield { type: "block-end", index: 0, block: { type: "text", text: "The advice report is ready." } };
    yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}

async function* toolCall(id: string, name: string, args: unknown) {
  const callId = id;
  const serialized = JSON.stringify(args);
  const block = { type: "tool-call" as const, id: callId, name, arguments: serialized };
  yield { type: "block-start", index: 0, blockType: "tool-call" };
  yield { type: "tool-call-delta", index: 0, id: callId, name, argumentsDelta: serialized };
  yield { type: "block-end", index: 0, block };
  yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
  yield { type: "finish", reason: { kind: "tool-calls" } };
}

test("runs one DSH observation through governed tools into a trusted Inbox proposal", async () => {
  const ctx = new Context();
  await ctx.plugin(AcceptanceWorld);
  await ctx.plugin(HomeProposalService, { path: ":memory:", now: () => "2026-08-19T04:00:00.000Z" });
  const adapter = new ObservationScriptAdapter();
  await ctx.plugin(DshHomeAgentService, {
    provider: "acceptance-provider",
    model: "acceptance-model",
    adapter: adapter as never,
    sessionId: "acceptance-home",
  });
  await ctx.plugin(ProposalInboxService);

  await ctx.homeAgent.requestObservation();

  assert.equal(adapter.requests.length, 9);
  assert.deepEqual(ctx.homeAgent.traceSnapshot()?.tools.map((tool) => tool.name), [
    "skill",
    "get_home_calibration",
    "get_home_inventory",
    "get_home_activity",
    "get_home_snapshot",
    "get_home_evidence",
    "get_home_rules",
    "create_home_proposal",
  ]);
  const [summary] = ctx.homeInbox.list({ status: "pending_review" });
  assert.equal(summary?.title, "Review repeated light activity");
  const detail = ctx.homeInbox.detail(summary!.id)!;
  assert.deepEqual(detail.proposal.evidence.references, [{
    bridgeId: "bridge-a",
    hwId: "hw-1",
    capabilityId: "hwc-1",
    observedAt: "2026-08-19T03:30:00.000Z",
    source: "post-baseline-event",
    epochId: "epoch-a",
    seq: 11,
  }]);
  assert.equal(detail.proposal.evidence.temporal?.coverage[0]?.status, "complete");
  assert.deepEqual(detail.proposal.rationale, {
    householdValue: "Reduce unnecessary repeated lighting while preserving household comfort.",
    whyNow: "A post-baseline event is available with complete temporal coverage.",
    uncertainties: ["Whether the observed light activity was intentional."],
  });
  assert.deepEqual(detail.proposal.spaceCoverage, {
    selectedDevices: 1,
    devicesWithSingleSpace: 1,
    devicesWithoutSpace: 0,
    devicesWithMultipleSpaces: 0,
  });
  assert.equal(detail.proposal.conflictCheck.existingAutomationCount, 1);
  assert.deepEqual(detail.proposal.conflictCheck.matches, [{
    identity: "opaque-rule-1",
    relation: "possible_overlap",
  }]);
  assert.equal(detail.proposal.applicationStatus, "not_available");

  await ctx.fiber.dispose();
});

test("answers a curtain question through governed DSH evidence into the local Inbox without proposing a change", async () => {
  const ctx = new Context();
  await ctx.plugin(AcceptanceWorld);
  await ctx.plugin(HomeProposalService, { path: ":memory:", now: () => "2026-08-19T04:00:00.000Z" });
  const adapter = new AdviceScriptAdapter();
  await ctx.plugin(DshHomeAgentService, {
    provider: "acceptance-provider",
    model: "acceptance-model",
    adapter: adapter as never,
    sessionId: "acceptance-advice",
  });
  await ctx.plugin(HomeAdviceService, {
    path: ":memory:",
    clock: () => "2026-08-19T04:00:00.000Z",
  });
  await ctx.plugin(ProposalInboxService);

  const answer = await ctx.homeInbox.askAdvice("Why does the curtain sometimes open too early and sometimes too late?");

  assert.equal(answer.status, "completed");
  if (answer.status !== "completed") return;
  assert.equal(answer.report.hardwareSuggestions[0]?.capability, "illuminance");
  assert.equal(answer.report.hardwareSuggestions[0]?.necessity, "optional");
  assert.match(ctx.homeInbox.renderAdvice(answer.id) ?? "", /No-purchase alternative/);
  assert.match(ctx.homeInbox.renderList(), /Why does the curtain/);
  assert.equal(ctx.homeInbox.list().length, 0);
  assert.deepEqual(ctx.homeAgent.traceSnapshot()?.tools.map((tool) => tool.name), [
    "skill",
    "get_home_calibration",
    "get_home_inventory",
    "get_home_activity",
    "get_home_snapshot",
    "get_home_evidence",
    "get_home_rules",
    "report_home_advice",
  ]);

  await ctx.fiber.dispose();
});
