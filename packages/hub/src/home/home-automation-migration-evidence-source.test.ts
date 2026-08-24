import assert from "node:assert/strict";
import test from "node:test";

import type { ForeignRuleMigrationResult } from "@hob/bridge-contract";

import { createForeignRuleArtifactCandidate } from "../artifact/foreign-rule-artifact-candidate.js";
import type { ForeignRuleArtifactCandidate } from "../artifact/foreign-rule-artifact-candidate.js";
import type {
  HomeAutomationMigrationSimulationSourceCut,
} from "./home-automation-migration-simulation.js";
import {
  HomeAutomationMigrationSimulationEvidenceSource,
  type HomeAutomationMigrationEvidenceHomeWorldPort,
} from "./home-automation-migration-evidence-source.js";

const SOURCE_CUT: HomeAutomationMigrationSimulationSourceCut = {
  bridgeId: "bridge-ha",
  epochId: "epoch-1",
  lastSeq: 12,
  configFingerprint: `sha256:${"a".repeat(64)}`,
};

const CURRENT_BINDING = {
  bridgeId: SOURCE_CUT.bridgeId,
  nativeId: "light.living-room",
  nativeInstanceId: "light.living-room:main",
} as const;

const CONDITION_BINDING = {
  bridgeId: SOURCE_CUT.bridgeId,
  nativeId: "sensor.living-room",
  nativeInstanceId: "sensor.living-room:main",
} as const;

const TARGET = {
  hwCapabilityId: "hwc-living-room",
  binding: CURRENT_BINDING,
} as const;

const CONDITION_TARGET = {
  hwCapabilityId: "hwc-living-room-temperature",
  binding: CONDITION_BINDING,
} as const;

function translated(
  ruleRef: string,
  overrides: Partial<Extract<ForeignRuleMigrationResult, { status: "translated" }>> = {},
): Extract<ForeignRuleMigrationResult, { status: "translated" }> {
  return {
    status: "translated",
    ruleRef,
    sourceFingerprint: SOURCE_CUT.configFingerprint,
    title: ruleRef,
    plan: {
      trigger: { kind: "capability_changed", source: CURRENT_BINDING },
      conditions: [{
        kind: "capability_value",
        source: CONDITION_BINDING,
        operator: "greater_than",
        value: 20,
      }],
      actions: [{ kind: "set_boolean", target: CURRENT_BINDING, value: true }],
    },
    ...overrides,
  };
}

function catalog(rules: readonly { ruleRef: string; enabled?: boolean }[]) {
  return {
    bridgeId: SOURCE_CUT.bridgeId,
    status: "available" as const,
    epochId: SOURCE_CUT.epochId,
    lastSeq: SOURCE_CUT.lastSeq,
    rules: rules.map((rule) => ({ ...rule })),
  };
}

function candidateFrom(result: ForeignRuleMigrationResult): ForeignRuleArtifactCandidate {
  const value = createForeignRuleArtifactCandidate(result, (binding) => (
    binding.nativeInstanceId === CONDITION_BINDING.nativeInstanceId ? CONDITION_TARGET : TARGET
  ));
  assert.equal(value.status, "candidate");
  return value;
}

function evidenceResult() {
  return {
    requestedSince: "2026-08-17T00:00:00.000Z",
    requestedUntil: "2026-08-24T00:00:00.000Z",
    events: [
      {
        hwId: "hw-light",
        hwCapabilityId: "hwc-living-room-temperature",
        value: 21,
        observedAt: "2026-08-23T09:00:00.000Z",
        sourceTsQuality: "platform" as const,
        origin: "observed" as const,
        provenance: { bridgeId: SOURCE_CUT.bridgeId, epochId: SOURCE_CUT.epochId, seq: 13 },
      },
      {
        hwId: "hw-light",
        hwCapabilityId: "hwc-living-room",
        value: true,
        observedAt: "2026-08-23T10:00:00.000Z",
        sourceTsQuality: "platform" as const,
        origin: "observed" as const,
        provenance: { bridgeId: SOURCE_CUT.bridgeId, epochId: SOURCE_CUT.epochId, seq: 14 },
      },
    ],
    coverage: [{
      bridgeId: SOURCE_CUT.bridgeId,
      epochId: SOURCE_CUT.epochId,
      baselineSeq: SOURCE_CUT.lastSeq,
      status: "complete" as const,
      reasons: [],
    }],
    truncated: false,
  };
}

function source(overrides: Partial<HomeAutomationMigrationEvidenceHomeWorldPort> = {}) {
  const translations: Record<string, unknown> = {
    "rule-current": translated("rule-current"),
    "rule-existing": translated("rule-existing", {
      plan: {
        trigger: { kind: "capability_changed", source: CURRENT_BINDING },
        conditions: [],
        actions: [{ kind: "notify_local", message: "Existing rule" }],
      },
    }),
  };
  const world: HomeAutomationMigrationEvidenceHomeWorldPort = {
    foreignRuleCatalog: async () => [catalog([
      { ruleRef: "rule-current", enabled: true },
      { ruleRef: "rule-existing", enabled: true },
    ])],
    translateForeignRule: async ({ ruleRef }) => translations[ruleRef],
    resolveBridgeActionTargetForBinding: (binding) => binding.nativeInstanceId === CONDITION_BINDING.nativeInstanceId
      ? CONDITION_TARGET
      : TARGET,
    queryRecentEvidence: () => evidenceResult(),
    ...overrides,
  };
  return world;
}

test("reads stable HomeWorld evidence into deterministic dual-run samples and existing summaries", async () => {
  const world = source();
  const evidence = await new HomeAutomationMigrationSimulationEvidenceSource(world).read({
    sourceCut: SOURCE_CUT,
    candidate: candidateFrom(translated("rule-current")),
    signal: new AbortController().signal,
  });

  assert.ok(evidence);
  assert.deepEqual(evidence.sourceCut, SOURCE_CUT);
  assert.deepEqual(evidence.eventSamples, [{
    eventId: "capability_changed:bridge-ha:epoch-1:14:hwc-living-room",
    kind: "capability_changed",
    occurredAt: "2026-08-23T10:00:00.000Z",
    capabilityId: "hwc-living-room",
    values: [
      { capabilityId: "hwc-living-room", value: true },
      { capabilityId: "hwc-living-room-temperature", value: 21 },
    ],
  }]);
  assert.deepEqual(evidence.existingRuleSummaries, [{
    ruleRef: "rule-existing",
    enabled: true,
    trigger: { kind: "capability_changed", sourceCapabilityId: "hwc-living-room" },
    actions: [{ kind: "notify_local", message: "Existing rule" }],
  }]);
  assert.deepEqual((world.queryRecentEvidence as unknown as { calls?: unknown[] }).calls, undefined);
});

test("uses the fixed bounded evidence query and rejects an unstable catalog cut", async () => {
  const queries: unknown[] = [];
  let catalogReads = 0;
  const world = source({
    queryRecentEvidence: (input) => {
      queries.push(input);
      return evidenceResult();
    },
    foreignRuleCatalog: async () => {
      catalogReads += 1;
      return [catalog(catalogReads === 1
        ? [{ ruleRef: "rule-current", enabled: true }, { ruleRef: "rule-existing", enabled: true }]
        : [{ ruleRef: "rule-current", enabled: true }])];
    },
  });
  const result = await new HomeAutomationMigrationSimulationEvidenceSource(world).read({
    sourceCut: SOURCE_CUT,
    candidate: candidateFrom(translated("rule-current")),
    signal: new AbortController().signal,
  });

  assert.equal(result, undefined);
  assert.deepEqual(queries, [{
    hwCapabilityIds: ["hwc-living-room", "hwc-living-room-temperature"],
    lookbackHours: 168,
    limit: 32,
  }]);
});

test("rejects duplicate and over-limit catalogs before translating rules", async () => {
  const invalidCatalogSets = [
    [catalog([{ ruleRef: "rule-current", enabled: true }, { ruleRef: "rule-current", enabled: true }])],
    [catalog(Array.from({ length: 65 }, (_, index) => ({
      ruleRef: index === 0 ? "rule-current" : `rule-${index}`,
      enabled: true,
    })))],
    [catalog([{ ruleRef: "rule-current", enabled: true }]), catalog([{ ruleRef: "rule-current", enabled: true }])],
  ];

  for (const catalogs of invalidCatalogSets) {
    let translateCalls = 0;
    const result = await new HomeAutomationMigrationSimulationEvidenceSource(source({
      foreignRuleCatalog: async () => catalogs,
      translateForeignRule: async () => {
        translateCalls += 1;
        return translated("rule-current");
      },
    })).read({
      sourceCut: SOURCE_CUT,
      candidate: candidateFrom(translated("rule-current")),
      signal: new AbortController().signal,
    });
    assert.equal(result, undefined);
    assert.equal(translateCalls, 0);
  }
});

test("does not silently omit an enabled existing rule that cannot map", async () => {
  let translatedRefs: string[] = [];
  const world = source({
    translateForeignRule: async ({ ruleRef }) => {
      translatedRefs.push(ruleRef);
      return ruleRef === "rule-existing" ? { status: "unsupported", reason: "unsupported_action" } : translated("rule-current");
    },
  });
  const result = await new HomeAutomationMigrationSimulationEvidenceSource(world).read({
    sourceCut: SOURCE_CUT,
    candidate: candidateFrom(translated("rule-current")),
    signal: new AbortController().signal,
  });

  assert.equal(result, undefined);
  assert.deepEqual(translatedRefs, ["rule-existing"]);
});

test("accepts each existing rule's own source fingerprint", async () => {
  const world = source({
    translateForeignRule: async ({ ruleRef }) => ruleRef === "rule-existing"
      ? translated("rule-existing", { sourceFingerprint: `sha256:${"b".repeat(64)}` })
      : translated("rule-current"),
  });
  const evidence = await new HomeAutomationMigrationSimulationEvidenceSource(world).read({
    sourceCut: SOURCE_CUT,
    candidate: candidateFrom(translated("rule-current")),
    signal: new AbortController().signal,
  });
  assert.ok(evidence);
  assert.equal(evidence.existingRuleSummaries.length, 1);
});

test("rejects aborted reads, incomplete coverage, truncation, and source-cut sequence mismatches", async () => {
  const aborted = new AbortController();
  aborted.abort();
  assert.equal(await new HomeAutomationMigrationSimulationEvidenceSource(source()).read({
    sourceCut: SOURCE_CUT,
    candidate: candidateFrom(translated("rule-current")),
    signal: aborted.signal,
  }), undefined);

  for (const evidenceOverride of [
    { ...evidenceResult(), coverage: [{ ...evidenceResult().coverage[0], status: "partial" as const, reasons: ["history_gap" as const] }] },
    { ...evidenceResult(), truncated: true },
    { ...evidenceResult(), events: evidenceResult().events.map((event) => ({
      ...event,
      provenance: { ...event.provenance, bridgeId: "bridge-other" },
    })) },
    { ...evidenceResult(), events: evidenceResult().events.map((event) => ({
      ...event,
      provenance: { ...event.provenance, seq: SOURCE_CUT.lastSeq },
    })) },
  ]) {
    assert.equal(await new HomeAutomationMigrationSimulationEvidenceSource(source({
      queryRecentEvidence: () => evidenceOverride,
    })).read({
      sourceCut: SOURCE_CUT,
      candidate: candidateFrom(translated("rule-current")),
      signal: new AbortController().signal,
    }), undefined);
  }
});

test("rejects a translated existing rule whose binding belongs to another bridge", async () => {
  const otherBinding = { ...CURRENT_BINDING, bridgeId: "bridge-other" };
  const world = source({
    translateForeignRule: async ({ ruleRef }) => ruleRef === "rule-existing"
      ? translated("rule-existing", {
        plan: {
          trigger: { kind: "capability_changed", source: otherBinding },
          conditions: [],
          actions: [{ kind: "notify_local", message: "Other bridge" }],
        },
      })
      : translated("rule-current"),
    resolveBridgeActionTargetForBinding: (binding) => ({
      hwCapabilityId: "hwc-other",
      binding: { ...binding },
    }),
  });
  assert.equal(await new HomeAutomationMigrationSimulationEvidenceSource(world).read({
    sourceCut: SOURCE_CUT,
    candidate: candidateFrom(translated("rule-current")),
    signal: new AbortController().signal,
  }), undefined);
});

test("keeps trigger samples with missing condition observations for the simulator to classify as ambiguous", async () => {
  const evidence = await new HomeAutomationMigrationSimulationEvidenceSource(source({
    queryRecentEvidence: () => ({
      ...evidenceResult(),
      events: evidenceResult().events.slice(1),
    }),
  })).read({
    sourceCut: SOURCE_CUT,
    candidate: candidateFrom(translated("rule-current")),
    signal: new AbortController().signal,
  });

  assert.ok(evidence);
  assert.deepEqual(evidence.eventSamples[0]?.values, [{ capabilityId: "hwc-living-room", value: true }]);
});

test("does not claim dual-run evidence when the history contains no trigger occurrence", async () => {
  const result = await new HomeAutomationMigrationSimulationEvidenceSource(source({
    queryRecentEvidence: () => ({
      ...evidenceResult(),
      events: evidenceResult().events.slice(0, 1),
    }),
  })).read({
    sourceCut: SOURCE_CUT,
    candidate: candidateFrom(translated("rule-current")),
    signal: new AbortController().signal,
  });

  assert.equal(result, undefined);
});

test("does not produce first-phase schedule evidence", async () => {
  let queryCalls = 0;
  const scheduled = translated("rule-current", {
    plan: {
      trigger: { kind: "schedule", timezone: "UTC", daysOfWeek: [1], at: "09:00" },
      conditions: [],
      actions: [{ kind: "notify_local", message: "Scheduled" }],
    },
  });
  const world = source({
    translateForeignRule: async ({ ruleRef }) => ruleRef === "rule-current" ? scheduled : translated("rule-existing"),
    queryRecentEvidence: () => {
      queryCalls += 1;
      return evidenceResult();
    },
  });
  assert.equal(await new HomeAutomationMigrationSimulationEvidenceSource(world).read({
    sourceCut: SOURCE_CUT,
    candidate: candidateFrom(scheduled),
    signal: new AbortController().signal,
  }), undefined);
  assert.equal(queryCalls, 0);
});
