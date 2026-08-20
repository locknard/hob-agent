import assert from "node:assert/strict";
import test from "node:test";

import {
  projectControlCenter,
  renderControlCenter,
  type ControlCenterWorldSnapshot,
} from "./control-center.js";

function worldSnapshot(overrides: Partial<ControlCenterWorldSnapshot> = {}): ControlCenterWorldSnapshot {
  return {
    bridges: {
      "bridge-main": {
        adapterType: "home-assistant",
        diagnostics: {
          connectionState: "ready",
          currentProcessReadyAt: "2026-08-20T09:00:00.000Z",
          lastSyncCompleteAt: "2026-08-20T09:00:00.000Z",
          lastSuccessfulContactAt: "2026-08-20T09:00:01.000Z",
        },
        watermark: { epochId: "epoch-main", lastSeq: 12 },
        metrics: { consistency: "ready" },
      },
    },
    bridgeWatermarks: [{ bridgeId: "bridge-main" }],
    diagnostics: [{
      bridgeId: "bridge-main",
      connectionState: "ready",
      currentProcessReadyAt: "2026-08-20T09:00:00.000Z",
    }],
    spaces: [{ hwSpaceId: "space-kitchen" }],
    devices: [
      { bindings: [{ hwSpaceId: "space-kitchen" }], capabilities: [{}], states: [{}] },
      { bindings: [], capabilities: [{}], states: [{}] },
    ],
    ...overrides,
  };
}

function emptyQualitySummary() {
  return {
    total: 0,
    statuses: { pending_review: 0, approved: 0, rejected: 0, expired: 0 },
    feedback: {
      useful_as_is: 0,
      already_covered: 0,
      not_useful: 0,
      incorrect_assumption: 0,
      insufficient_evidence: 0,
      household_preference: 0,
      too_risky: 0,
      other: 0,
    },
    reviewedWithoutFeedback: 0,
  };
}

test("projects bridge, model, home-map, Agent, observation, and Inbox health without payloads", () => {
  const snapshot = projectControlCenter({
    world: {
      snapshot: () => worldSnapshot(),
      identity: { proposals: () => [{ kind: "identity-link", status: "proposed" }] },
    },
    agent: {
      agent: { options: { provider: "openai", model: "gpt-5.6" }, status: "idle" },
      observationStatus: "idle",
    },
    observation: {
      snapshot: () => ({ enabled: true, intervalMinutes: 360, runOnStart: false, state: "waiting" }),
    },
    proposals: {
      qualitySummary: () => ({
        total: 4,
        statuses: { pending_review: 1, approved: 2, rejected: 1, expired: 0 },
        feedback: {
          useful_as_is: 1,
          already_covered: 0,
          not_useful: 0,
          incorrect_assumption: 0,
          insufficient_evidence: 0,
          household_preference: 0,
          too_risky: 0,
          other: 0,
        },
        reviewedWithoutFeedback: 0,
      }),
    },
  }, "2026-08-20T09:01:00.000Z");

  assert.equal(snapshot.status, "ready");
  assert.equal(snapshot.bridges[0]?.status, "ready");
  assert.deepEqual(snapshot.model, { status: "configured", provider: "openai", model: "gpt-5.6" });
  assert.deepEqual(snapshot.homeMap, {
    status: "ready",
    spaces: 1,
    devices: 2,
    devicesWithSingleSpace: 1,
    devicesWithoutSpace: 1,
    devicesNeedingSpaceReview: 1,
    devicesWithMultipleSpaces: 0,
    devicesNotRequiringSpace: 0,
    proposedIdentityLinks: 1,
    proposedCapabilityBindings: 0,
  });
  assert.equal(snapshot.agent.status, "ready");
  assert.equal(snapshot.observation.status, "enabled");
  assert.equal(snapshot.systemChecks.some((check) => check.key === "observation" && check.status === "ready"), true);
  assert.deepEqual(snapshot.inbox, { status: "ready", pendingReviewCount: 1, totalProposalCount: 4 });

  const html = renderControlCenter(snapshot);
  assert.match(html, /Home at a glance/);
  assert.match(html, /home-assistant/);
  assert.match(html, /gpt-5\.6/);
  assert.match(html, /1 idea ready for review/);
  assert.match(html, /Home map readiness/);
  assert.equal(html.includes("epoch-main"), false);
  assert.equal(html.includes("space-kitchen"), false);
  assert.equal(html.includes("api-key"), false);
});

test("treats pending household reviews as normal work rather than a system fault", () => {
  const snapshot = projectControlCenter({
    world: { snapshot: () => worldSnapshot() },
    agent: {
      agent: { options: { provider: "openai", model: "gpt-5.6" }, status: "idle" },
      observationStatus: "idle",
    },
    observation: { snapshot: () => ({ enabled: false, runOnStart: false, state: "waiting" }) },
    proposals: {
      qualitySummary: () => ({
        ...emptyQualitySummary(),
        total: 1,
        statuses: { ...emptyQualitySummary().statuses, pending_review: 1 },
      }),
    },
  });

  assert.equal(snapshot.status, "ready");
  assert.equal(snapshot.systemChecks.find((check) => check.key === "inbox")?.status, "ready");
  const html = renderControlCenter(snapshot);
  assert.match(html, /1 idea ready for review/i);
  assert.match(html, /href="\/proposals#reviews"/);
  assert.equal(html.includes("System Needs attention"), false);
});

test("does not report a bridge as ready when its consistent view is degraded", () => {
  const snapshot = projectControlCenter({
    world: { snapshot: () => worldSnapshot({
      bridges: {
        "bridge-main": {
          ...worldSnapshot().bridges["bridge-main"]!,
          metrics: { consistency: "degraded" },
        },
      },
    }) },
  });

  assert.equal(snapshot.bridges[0]?.consistency, "degraded");
  assert.equal(snapshot.bridges[0]?.status, "attention");
});

test("treats disabled recurring observation as intentional manual mode", () => {
  const snapshot = projectControlCenter({
    world: { snapshot: () => worldSnapshot() },
    agent: {
      agent: { options: { provider: "openai", model: "gpt-5.6" }, status: "idle" },
      observationStatus: "idle",
    },
    observation: {
      snapshot: () => ({ enabled: false, runOnStart: false, state: "waiting" }),
    },
    proposals: { qualitySummary: emptyQualitySummary },
  }, "2026-08-20T09:01:00.000Z");

  assert.equal(snapshot.status, "ready");
  assert.deepEqual(snapshot.observation, { status: "disabled", state: "waiting" });
  assert.equal(snapshot.systemChecks.find((check) => check.key === "observation")?.status, "ready");

  const html = renderControlCenter(snapshot);
  assert.match(html, />Manual<\/span>/);
  assert.match(html, /Runs only when you choose Observe now/);
  assert.equal(html.includes("Needs attention"), false);
});

test("does not present explicitly non-spatial devices as home-map review work", () => {
  const snapshot = projectControlCenter({
    world: { snapshot: () => worldSnapshot({
      devices: [
        { bindings: [{ hwSpaceId: "space-kitchen" }], capabilities: [{}], states: [{}] },
        { spatialDisposition: "non_spatial", bindings: [], capabilities: [{}], states: [{}] },
      ],
    }) },
  });

  assert.equal(snapshot.homeMap.devicesWithoutSpace, 1);
  assert.equal(snapshot.homeMap.devicesNotRequiringSpace, 1);
  assert.equal(snapshot.homeMap.devicesNeedingSpaceReview, 0);
  assert.match(renderControlCenter(snapshot), /0 need space review/);
});

test("keeps a custom DSH model route behind plain-language progressive disclosure", () => {
  const snapshot = projectControlCenter({
    world: { snapshot: () => worldSnapshot() },
    agent: {
      agent: { options: { provider: "hob-custom-openai", model: "household-model" }, status: "idle" },
    },
    proposals: { qualitySummary: emptyQualitySummary },
  }, "2026-08-20T09:01:00.000Z");

  const html = renderControlCenter(snapshot);
  assert.match(html, /Custom model connection/);
  assert.match(html, /household-model/);
  assert.match(html, /<summary>Technical diagnostics<\/summary>/);
  assert.equal(html.indexOf("Technical diagnostics") < html.indexOf("hob-custom-openai"), true);
  assert.equal(html.indexOf("Technical diagnostics") < html.indexOf("bridge-main"), true);
});

test("keeps an incomplete world and missing runtime services explicitly unavailable", () => {
  const snapshot = projectControlCenter({
    world: { snapshot: () => worldSnapshot({
      bridges: {},
      bridgeWatermarks: [],
      diagnostics: [],
      spaces: [],
      devices: [],
    }) },
  });

  assert.equal(snapshot.status, "attention");
  assert.equal(snapshot.homeMap.status, "not_ready");
  assert.equal(snapshot.model.status, "unavailable");
  assert.equal(snapshot.agent.status, "unavailable");
  assert.equal(snapshot.observation.status, "unavailable");
  assert.equal(snapshot.inbox.status, "unavailable");
  const html = renderControlCenter(snapshot);
  assert.match(html, /No live home connection is available/);
  assert.match(html, /No live model connection is available/);
  assert.equal(html.includes("undefined"), false);
});

test("does not call a model or expose launch credential material while projecting status", () => {
  let modelCalls = 0;
  const snapshot = projectControlCenter({
    agent: {
      agent: {
        options: {
          provider: "openai",
          model: "gpt-5.6",
        },
        status: "idle",
      },
    },
    proposals: {
      qualitySummary: () => {
        modelCalls += 1;
        return {
          total: 0,
          statuses: { pending_review: 0, approved: 0, rejected: 0, expired: 0 },
          feedback: {
            useful_as_is: 0,
            already_covered: 0,
            not_useful: 0,
            incorrect_assumption: 0,
            insufficient_evidence: 0,
            household_preference: 0,
            too_risky: 0,
            other: 0,
          },
          reviewedWithoutFeedback: 0,
        };
      },
    },
  });

  assert.equal(modelCalls, 1);
  assert.equal(JSON.stringify(snapshot).includes("OPENAI_API_KEY"), false);
  assert.equal(JSON.stringify(snapshot).includes("super-secret"), false);
});

test("keeps retention operations metadata-only and never shows Ready for partial coverage", () => {
  const snapshot = projectControlCenter({
    world: { snapshot: () => worldSnapshot() },
    retention: {
      snapshot: () => ({
        status: "attention" as const,
        capacity: { usedBytes: 800, maxBytes: 2_000, remainingBytes: 1_200 },
        bridges: [{
          bridgeId: "bridge-main",
          status: "attention" as const,
          capacity: { usedBytes: 800, maxBytes: 2_000, remainingBytes: 1_200 },
          coverage: { status: "partial" as const, coverageFloor: "2026-08-13T00:00:00.000Z" },
        }],
      }),
    },
  });

  assert.equal(snapshot.retention.status, "attention");
  assert.equal(snapshot.systemChecks.find((check) => check.key === "retention")?.status, "attention");
  assert.equal(snapshot.status, "attention");
  const html = renderControlCenter(snapshot);
  assert.match(html, /Evidence retention/);
  assert.match(html, /partial/);
  assert.match(html, /2026-08-13/);
  assert.match(html, /800 bytes/);
  assert.equal(html.includes("policy-id"), false);
  assert.equal(html.includes("raw-device-value"), false);
});

test("reports a bridge with no retention audit as Not run yet", () => {
  const snapshot = projectControlCenter({
    world: { snapshot: () => worldSnapshot() },
    agent: { agent: { options: { provider: "openai", model: "gpt-5.6" }, status: "idle" } },
    observation: { snapshot: () => ({ enabled: false, runOnStart: false, state: "waiting" as const }) },
    proposals: { qualitySummary: emptyQualitySummary },
    retention: {
      snapshot: () => ({
        status: "ready" as const,
        capacity: { usedBytes: 0, maxBytes: 1_000, remainingBytes: 1_000 },
        bridges: [{
          bridgeId: "bridge-main",
          status: "ready" as const,
          capacity: { usedBytes: 0, maxBytes: 1_000, remainingBytes: 1_000 },
          coverage: { status: "complete" as const },
        }],
      }),
    },
  });

  const html = renderControlCenter(snapshot);
  assert.equal(snapshot.status, "ready");
  assert.equal(snapshot.retention.status, "ready");
  assert.match(html, /Not run yet/);
});
