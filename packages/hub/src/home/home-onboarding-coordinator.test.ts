import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Context, Service } from "@deepseek-ai/cordis";

import {
  HomeOnboardingCoordinatorService,
  HomeOnboardingCoordinatorError,
  type OnboardingActionAuthorityPort,
  type OnboardingAdvicePort,
  type OnboardingActor,
  type OnboardingObservationPort,
  type OnboardingWorldPort,
} from "./home-onboarding-coordinator.js";
import { InMemoryHomeOnboardingStore } from "./home-onboarding-store.js";

class StubWorld extends Service {
  constructor(ctx: Context, private readonly source: OnboardingWorldPort) { super(ctx, "homeWorld"); }
  snapshot(): ReturnType<OnboardingWorldPort["snapshot"]> { return this.source.snapshot(); }
}

const adultPrivate: OnboardingActor = {
  principalId: "adult-1",
  role: "adult_member",
  present: true,
  device: { kind: "private", boundPrincipalId: "adult-1" },
};

const testHouseholdDirectory = mkdtempSync(join(tmpdir(), "hob-home-onboarding-coordinator-"));

function world(ready = true): OnboardingWorldPort {
  return {
    snapshot: () => ({
      generatedAt: "2026-08-22T00:00:00.000Z",
      bridges: {
        "home-assistant": {
          bridgeId: "home-assistant",
          diagnostics: { connectionState: ready ? "ready" : "down" },
          watermark: ready ? { bridgeId: "home-assistant", epochId: "epoch-1", lastSeq: 4 } : null,
          devices: [{
            hwId: "hw-light",
            validity: "valid",
            capabilities: [{ hwCapabilityId: "cap-light", bindings: [], schema: "boolean", schemaVersion: "1" }],
          }],
        },
      },
      spaces: [{ hwSpaceId: "space-living", name: "客厅" }],
      devices: [{
        hwId: "hw-light",
        validity: "valid",
        capabilities: [{ hwCapabilityId: "cap-light", bindings: [], schema: "boolean", schemaVersion: "1" }],
      }],
    }),
  } as OnboardingWorldPort;
}

async function coordinator(
  source = world(),
  actionAuthority: OnboardingActionAuthorityPort | null = {
    configure: () => ({ status: "configured", configurationRevision: 1 }),
  },
  observation: OnboardingObservationPort | null = {
    configure: () => ({ status: "configured" }),
  },
  advice: OnboardingAdvicePort | null = {
    ask: async (question: string) => ({ id: `advice-${question.length}`, status: "running" as const }),
  },
): Promise<{ context: Context; fiber: Awaited<ReturnType<Context["plugin"]>>; service: HomeOnboardingCoordinatorService }> {
  const context = new Context();
  const worldFiber = await context.plugin(StubWorld, source);
  const fiber = await context.plugin(HomeOnboardingCoordinatorService, {
    store: new InMemoryHomeOnboardingStore(),
    householdDirectory: testHouseholdDirectory,
    ...(actionAuthority === null ? {} : { actionAuthority }),
    ...(observation === null ? {} : { observation }),
    ...(advice === null ? {} : { advice }),
    now: () => "2026-08-22T00:00:00.000Z",
  });
  return { context, fiber, service: context.homeOnboarding };
}

test("the settings confirmation editor re-decides methods under step-5 rules", async () => {
  const configured: unknown[] = [];
  const { context, fiber, service } = await coordinator(undefined, {
    configure: (input) => {
      configured.push(input);
      return { status: "configured", configurationRevision: configured.length };
    },
  });
  try {
    const choices = service.actionPolicyChoices();
    assert.equal(choices.status, "available", "settings reads the same live choices seam as step 5");

    assert.throws(
      () => service.configureActionPolicy(
        { directCapabilityIds: ["cap-light"], confirmationCapabilityIds: [], administratorCapabilityIds: [] },
        { ...adultPrivate, device: { kind: "shared" } },
      ),
      (error: unknown) => (error as { code?: string }).code === "permission_denied",
      "a shared screen cannot re-decide confirmation methods",
    );

    const unknown = service.configureActionPolicy(
      { directCapabilityIds: ["cap-not-real"], confirmationCapabilityIds: [], administratorCapabilityIds: [] },
      adultPrivate,
    );
    assert.equal(unknown.status, "blocked", "capabilities must come from the current home map");
    assert.equal(configured.length, 0);

    const saved = service.configureActionPolicy(
      { directCapabilityIds: [], confirmationCapabilityIds: ["cap-light"], administratorCapabilityIds: [] },
      adultPrivate,
    );
    assert.equal(saved.status, "configured");
    assert.deepEqual(configured, [{ directCapabilityIds: [], confirmationCapabilityIds: ["cap-light"], administratorCapabilityIds: [] }]);
  } finally {
    await fiber.dispose();
    await context.fiber.dispose();
  }
});

test("executes the eight typed onboarding commands and persists each real result", async () => {
  const { context, fiber, service } = await coordinator();
  try {
    assert.equal(service.getState().step, 1);
    assert.equal(service.getState().title, "认识一下你家的 hob");
    assert.match(service.getState().body, /开始时我只会看/);
    assert.equal(service.submit({ step: 1, kind: "name_household", householdName: "小海的家", agentName: "阿灶" }).state.step, 2);
    assert.equal(service.submit({ step: 2, kind: "preflight_bridge", bridgeId: "home-assistant" }).state.step, 3);
    assert.equal(service.submit({ step: 3, kind: "confirm_map", confirmed: true }).state.step, 4);
    assert.equal(service.submit({ step: 4, kind: "bind_private_device", memberName: "小海", role: "adult_admin" }, adultPrivate).state.step, 5);
    assert.equal(service.submit({ step: 5, kind: "set_action_policy", directCapabilityIds: ["cap-light"], confirmationCapabilityIds: [], administratorCapabilityIds: [] }).state.step, 6);
    assert.equal(service.submit({ step: 6, kind: "acknowledge_safety_rules", acknowledged: true }).state.step, 7);
    assert.equal(service.submit({ step: 7, kind: "set_observation_schedule", enabled: true, intervalMinutes: 1_440, quietHours: { start: "22:00", end: "08:00" } }).state.step, 8);
    const final = await service.submit({ step: 8, kind: "ask_first_question", question: "窗帘为什么今天开晚了？" });
    assert.equal(final.complete, true);
    assert.equal(final.state.status, "complete");
    assert.deepEqual(service.getState().household, { householdName: "小海的家", agentName: "阿灶" });
    assert.equal(service.getState().firstQuestion?.question, "窗帘为什么今天开晚了？");
  } finally {
    await fiber.dispose();
    await context.fiber.dispose();
  }
});

test("starts a durable first-question advice turn before completing Step 8", async () => {
  let adviceCalls = 0;
  const advice = {
    ask: async (question: string) => {
      adviceCalls += 1;
      assert.equal(question, "窗帘为什么今天开晚了？");
      return { id: "advice-first-1", status: "running" };
    },
  };
  const context = new Context();
  const worldFiber = await context.plugin(StubWorld, world());
  const fiber = await context.plugin(HomeOnboardingCoordinatorService, {
    store: new InMemoryHomeOnboardingStore(),
    householdDirectory: testHouseholdDirectory,
    advice,
    actionAuthority: { configure: () => ({ status: "configured", configurationRevision: 1 }) },
    observation: { configure: () => ({ status: "configured" }) },
    now: () => "2026-08-22T00:00:00.000Z",
  } as never);
  try {
    const service = context.homeOnboarding;
    service.submit({ step: 1, kind: "name_household", householdName: "家", agentName: "助手" });
    service.submit({ step: 2, kind: "preflight_bridge", bridgeId: "home-assistant" });
    service.submit({ step: 3, kind: "confirm_map", confirmed: true });
    service.submit({ step: 4, kind: "bind_private_device", memberName: "管理员", role: "adult_admin" }, adultPrivate);
    service.submit({ step: 5, kind: "set_action_policy", directCapabilityIds: ["cap-light"], confirmationCapabilityIds: [], administratorCapabilityIds: [] });
    service.submit({ step: 6, kind: "acknowledge_safety_rules", acknowledged: true });
    service.submit({ step: 7, kind: "set_observation_schedule", enabled: false });

    const result = await service.submit({ step: 8, kind: "ask_first_question", question: "窗帘为什么今天开晚了？" }, adultPrivate);
    assert.equal(adviceCalls, 1);
    assert.equal(result.adviceId, "advice-first-1");
    assert.equal(result.complete, true);
    assert.deepEqual(service.getState().firstQuestion, {
      question: "窗帘为什么今天开晚了？",
      adviceId: "advice-first-1",
      acceptedAt: "2026-08-22T00:00:00.000Z",
    });
  } finally {
    await fiber.dispose();
    await worldFiber.dispose();
    await context.fiber.dispose();
  }
});

test("blocks Step 1 when the household directory needed for names is unavailable", async () => {
  const directories: readonly (string | undefined)[] = [
    undefined,
    join(tmpdir(), `hob-home-onboarding-missing-${process.pid}-${Date.now()}`),
  ];
  for (const householdDirectory of directories) {
    const context = new Context();
    const fiber = await context.plugin(HomeOnboardingCoordinatorService, {
      store: new InMemoryHomeOnboardingStore(),
      ...(householdDirectory === undefined ? {} : { householdDirectory }),
      now: () => "2026-08-22T00:00:00.000Z",
    });
    try {
      const blocked = context.homeOnboarding.submit({ step: 1, kind: "name_household", householdName: "家", agentName: "助手" });
      assert.equal(blocked.outcome, "blocked");
      assert.equal(blocked.state.step, 1);
      assert.equal(blocked.state.status, "blocked");
      assert.match(blocked.state.blockedReason ?? "", /目录|名称|保存/);
    } finally {
      await fiber.dispose();
      await context.fiber.dispose();
    }
  }
});

test("keeps Step 8 blocked when HomeAdvice is unavailable or rejects the first question", async () => {
  const cases: readonly (OnboardingAdvicePort | null)[] = [
    null,
    { ask: async () => { throw new Error("advice unavailable"); } },
    { ask: async () => ({ id: "advice-failed", status: "failed" as const }) },
  ];
  for (const advice of cases) {
    const { context, fiber, service } = await coordinator(world(), undefined, undefined, advice);
    try {
      service.submit({ step: 1, kind: "name_household", householdName: "家", agentName: "助手" });
      service.submit({ step: 2, kind: "preflight_bridge", bridgeId: "home-assistant" });
      service.submit({ step: 3, kind: "confirm_map", confirmed: true });
      service.submit({ step: 4, kind: "bind_private_device", memberName: "管理员", role: "adult_admin" }, adultPrivate);
      service.submit({ step: 5, kind: "set_action_policy", directCapabilityIds: ["cap-light"], confirmationCapabilityIds: [], administratorCapabilityIds: [] });
      service.submit({ step: 6, kind: "acknowledge_safety_rules", acknowledged: true });
      service.submit({ step: 7, kind: "set_observation_schedule", enabled: false });

      const blocked = await service.submit({ step: 8, kind: "ask_first_question", question: "家里现在怎么样？" }, adultPrivate);
      assert.equal(blocked.outcome, "blocked");
      assert.equal(blocked.complete, false);
      assert.equal(blocked.state.step, 8);
      assert.equal(blocked.state.status, "blocked");
      assert.equal(blocked.adviceId, undefined);
      assert.equal(service.getState().firstQuestion, undefined);
    } finally {
      await fiber.dispose();
      await context.fiber.dispose();
    }
  }
});

test("reuses the accepted advice id for concurrent and completed Step 8 retries", async () => {
  let calls = 0;
  let release: (() => void) | undefined;
  const advice: OnboardingAdvicePort = {
    ask: async () => {
      calls += 1;
      await new Promise<void>((resolve) => { release = resolve; });
      return { id: "advice-idempotent-1", status: "running" };
    },
  };
  const { context, fiber, service } = await coordinator(world(), undefined, undefined, advice);
  try {
    for (const command of [
      { step: 1, kind: "name_household", householdName: "家", agentName: "助手" },
      { step: 2, kind: "preflight_bridge", bridgeId: "home-assistant" },
      { step: 3, kind: "confirm_map", confirmed: true },
    ] as const) service.submit(command);
    service.submit({ step: 4, kind: "bind_private_device", memberName: "管理员", role: "adult_admin" }, adultPrivate);
    service.submit({ step: 5, kind: "set_action_policy", directCapabilityIds: ["cap-light"], confirmationCapabilityIds: [], administratorCapabilityIds: [] });
    service.submit({ step: 6, kind: "acknowledge_safety_rules", acknowledged: true });
    service.submit({ step: 7, kind: "set_observation_schedule", enabled: false });

    const command = { step: 8, kind: "ask_first_question" as const, question: "家里现在怎么样？" };
    const first = service.submit(command, adultPrivate);
    const second = service.submit(command, adultPrivate);
    assert.equal(calls, 1);
    release?.();
    const [accepted, replay] = await Promise.all([first, second]);
    assert.equal(accepted.adviceId, "advice-idempotent-1");
    assert.equal(replay.adviceId, "advice-idempotent-1");
    const completedRetry = await service.submit(command, adultPrivate);
    assert.equal(completedRetry.adviceId, "advice-idempotent-1");
    assert.equal(calls, 1);
  } finally {
    await fiber.dispose();
    await context.fiber.dispose();
  }
});

test("reuses the persisted advice id after the onboarding store is reopened", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-home-onboarding-first-question-"));
  const path = join(directory, "onboarding.sqlite");
  let adviceCalls = 0;
  const command = { step: 8, kind: "ask_first_question" as const, question: "家里现在怎么样？" };
  const advanceToFirstQuestion = (service: HomeOnboardingCoordinatorService): void => {
    service.submit({ step: 1, kind: "name_household", householdName: "家", agentName: "助手" });
    service.submit({ step: 2, kind: "preflight_bridge", bridgeId: "home-assistant" });
    service.submit({ step: 3, kind: "confirm_map", confirmed: true });
    service.submit({ step: 4, kind: "bind_private_device", memberName: "管理员", role: "adult_admin" }, adultPrivate);
    service.submit({ step: 5, kind: "set_action_policy", directCapabilityIds: ["cap-light"], confirmationCapabilityIds: [], administratorCapabilityIds: [] });
    service.submit({ step: 6, kind: "acknowledge_safety_rules", acknowledged: true });
    service.submit({ step: 7, kind: "set_observation_schedule", enabled: false });
  };
  const advice: OnboardingAdvicePort = {
    ask: async () => {
      adviceCalls += 1;
      return { id: "advice-persisted-1", status: "running" };
    },
  };
  let firstFiber: Awaited<ReturnType<Context["plugin"]>> | undefined;
  let secondFiber: Awaited<ReturnType<Context["plugin"]>> | undefined;
  const firstContext = new Context();
  const firstWorldFiber = await firstContext.plugin(StubWorld, world());
  try {
    firstFiber = await firstContext.plugin(HomeOnboardingCoordinatorService, {
      path,
      householdDirectory: testHouseholdDirectory,
      advice,
      actionAuthority: { configure: () => ({ status: "configured", configurationRevision: 1 }) },
      observation: { configure: () => ({ status: "configured" }) },
      now: () => "2026-08-22T00:00:00.000Z",
    });
    advanceToFirstQuestion(firstContext.homeOnboarding);
    const accepted = await firstContext.homeOnboarding.submit(command, adultPrivate);
    assert.equal(accepted.adviceId, "advice-persisted-1");
  } finally {
    await firstFiber?.dispose();
    await firstWorldFiber.dispose();
    await firstContext.fiber.dispose();
  }

  const secondContext = new Context();
  const secondWorldFiber = await secondContext.plugin(StubWorld, world());
  try {
    secondFiber = await secondContext.plugin(HomeOnboardingCoordinatorService, {
      path,
      householdDirectory: testHouseholdDirectory,
      advice: { ask: async () => { throw new Error("retry must use persisted advice"); } },
      now: () => "2026-08-22T00:01:00.000Z",
    });
    const replay = await secondContext.homeOnboarding.submit(command, adultPrivate);
    assert.equal(replay.adviceId, "advice-persisted-1");
    assert.equal(adviceCalls, 1);
  } finally {
    await secondFiber?.dispose();
    await secondWorldFiber.dispose();
    await secondContext.fiber.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps the current step blocked when the bridge preflight is unavailable", async () => {
  const { context, fiber, service } = await coordinator(world(false));
  try {
    service.submit({ step: 1, kind: "name_household", householdName: "家", agentName: "助手" });
    const blocked = service.submit({ step: 2, kind: "preflight_bridge", bridgeId: "home-assistant" });
    assert.equal(blocked.outcome, "blocked");
    assert.equal(blocked.state.step, 2);
    assert.match(blocked.state.blockedReason ?? "", /连接|ready|准备/i);
    assert.equal(service.getState().steps[2]?.status, "blocked");
  } finally {
    await fiber.dispose();
    await context.fiber.dispose();
  }
});

test("requires an adult member on a bound private device for device binding", async () => {
  const { context, fiber, service } = await coordinator();
  try {
    for (const command of [
      { step: 1, kind: "name_household", householdName: "家", agentName: "助手" },
      { step: 2, kind: "preflight_bridge", bridgeId: "home-assistant" },
      { step: 3, kind: "confirm_map", confirmed: true },
    ] as const) service.submit(command);
    assert.throws(
      () => service.submit({ step: 4, kind: "bind_private_device", memberName: "孩子", role: "adult_admin" }, {
        ...adultPrivate,
        role: "child",
        device: { kind: "shared", boundPrincipalId: "adult-1" },
      }),
      (error: unknown) => error instanceof HomeOnboardingCoordinatorError && error.code === "permission_denied",
    );
    assert.equal(service.getState().step, 4);
  } finally {
    await fiber.dispose();
    await context.fiber.dispose();
  }
});

test("persists names into the household source when a household directory is configured", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-home-onboarding-household-"));
  const soul = join(directory, "SOUL.md");
  const home = join(directory, "HOME.md");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(soul, "# SOUL\n\nYou are a considerate home steward.\n", { mode: 0o600 });
  await writeFile(home, "# Home\n", { mode: 0o600 });
  const context = new Context();
  const worldFiber = await context.plugin(StubWorld, world());
  const fiber = await context.plugin(HomeOnboardingCoordinatorService, {
    store: new InMemoryHomeOnboardingStore(),
    householdDirectory: directory,
    now: () => "2026-08-22T00:00:00.000Z",
  });
  try {
    context.homeOnboarding.submit({ step: 1, kind: "name_household", householdName: "小海的家", agentName: "阿灶" });
    assert.match(await readFile(soul, "utf8"), /家庭助手：阿灶/);
    assert.match(await readFile(home, "utf8"), /家庭名称：小海的家/);
  } finally {
    await fiber.dispose();
    await context.fiber.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("requires the action authority owner and applies selected classes instead of recording onboarding-only metadata", async () => {
  const { context, fiber, service } = await coordinator(world(), null);
  try {
    service.submit({ step: 1, kind: "name_household", householdName: "家", agentName: "助手" });
    service.submit({ step: 2, kind: "preflight_bridge", bridgeId: "home-assistant" });
    service.submit({ step: 3, kind: "confirm_map", confirmed: true });
    service.submit({ step: 4, kind: "bind_private_device", memberName: "管理员", role: "adult_admin" }, adultPrivate);
    const blocked = service.submit({ step: 5, kind: "set_action_policy", directCapabilityIds: ["cap-light"], confirmationCapabilityIds: [], administratorCapabilityIds: [] });
    assert.equal(blocked.outcome, "blocked");
    assert.equal(blocked.state.step, 5);
  } finally {
    await fiber.dispose();
    await context.fiber.dispose();
  }
});

test("applies the observation schedule through its runtime owner before advancing", async () => {
  const calls: Array<{ readonly enabled: boolean; readonly intervalMinutes?: number; readonly quietHours?: { readonly start: string; readonly end: string } }> = [];
  const observation: OnboardingObservationPort = {
    configure: (input) => {
      calls.push(input);
      return { status: "configured" };
    },
  };
  const { context, fiber, service } = await coordinator(world(), undefined, observation);
  try {
    for (const command of [
      { step: 1, kind: "name_household", householdName: "家", agentName: "助手" },
      { step: 2, kind: "preflight_bridge", bridgeId: "home-assistant" },
      { step: 3, kind: "confirm_map", confirmed: true },
    ] as const) service.submit(command);
    service.submit({ step: 4, kind: "bind_private_device", memberName: "管理员", role: "adult_admin" }, adultPrivate);
    service.submit({ step: 5, kind: "set_action_policy", directCapabilityIds: ["cap-light"], confirmationCapabilityIds: [], administratorCapabilityIds: [] });
    service.submit({ step: 6, kind: "acknowledge_safety_rules", acknowledged: true });
    const result = service.submit({ step: 7, kind: "set_observation_schedule", enabled: true, intervalMinutes: 720, quietHours: { start: "22:00", end: "08:00" } });
    assert.equal(result.outcome, "completed");
    assert.deepEqual(calls, [{ enabled: true, intervalMinutes: 720, quietHours: { start: "22:00", end: "08:00" } }]);
    assert.deepEqual(service.getState().observation, {
      enabled: true,
      intervalMinutes: 720,
      quietHours: { start: "22:00", end: "08:00" },
      configuredAt: "2026-08-22T00:00:00.000Z",
    });
  } finally {
    await fiber.dispose();
    await context.fiber.dispose();
  }
});

test("keeps observation onboarding blocked when its runtime owner is unavailable", async () => {
  const { context, fiber, service } = await coordinator(world(), undefined, null);
  try {
    for (const command of [
      { step: 1, kind: "name_household", householdName: "家", agentName: "助手" },
      { step: 2, kind: "preflight_bridge", bridgeId: "home-assistant" },
      { step: 3, kind: "confirm_map", confirmed: true },
    ] as const) service.submit(command);
    service.submit({ step: 4, kind: "bind_private_device", memberName: "管理员", role: "adult_admin" }, adultPrivate);
    service.submit({ step: 5, kind: "set_action_policy", directCapabilityIds: ["cap-light"], confirmationCapabilityIds: [], administratorCapabilityIds: [] });
    service.submit({ step: 6, kind: "acknowledge_safety_rules", acknowledged: true });
    const blocked = service.submit({ step: 7, kind: "set_observation_schedule", enabled: true, intervalMinutes: 720 });
    assert.equal(blocked.outcome, "blocked");
    assert.equal(blocked.state.step, 7);
    assert.equal(blocked.state.observation, undefined);
  } finally {
    await fiber.dispose();
    await context.fiber.dispose();
  }
});

test("projects the current ready bridges and valid capabilities for onboarding choices", async () => {
  const source = {
    snapshot: () => ({
      generatedAt: "2026-08-22T00:00:00.000Z",
      bridges: {
        "xiaomi-main": {
          bridgeId: "xiaomi-main",
          adapterType: "xiaomi-home",
          diagnostics: { connectionState: "ready" },
          watermark: { bridgeId: "xiaomi-main", epochId: "epoch-x", lastSeq: 7 },
        },
        "custom-main": {
          bridgeId: "custom-main",
          adapterType: "openai-compatible",
          diagnostics: { connectionState: "ready" },
          watermark: { bridgeId: "custom-main", epochId: "epoch-c", lastSeq: 8 },
        },
        "offline-main": {
          bridgeId: "offline-main",
          adapterType: "home-assistant",
          diagnostics: { connectionState: "down" },
          watermark: null,
        },
      },
      spaces: [{ hwSpaceId: "space-living", name: "客厅" }],
      devices: [
        {
          hwId: "hw-lamp",
          name: "客厅主灯",
          validity: "valid",
          capabilities: [{ hwCapabilityId: "cap-lamp", schema: "boolean", semanticKind: "light", bindings: [{ bridgeId: "xiaomi-main" }] }],
        },
        {
          hwId: "hw-lock",
          name: "入户门",
          validity: "valid",
          capabilities: [{ hwCapabilityId: "cap-lock", schema: "boolean", semanticKind: "lock", bindings: [{ bridgeId: "custom-main" }] }],
        },
        {
          hwId: "hw-stale",
          name: "旧设备",
          validity: "stale",
          capabilities: [{ hwCapabilityId: "cap-stale", schema: "boolean", semanticKind: "light", bindings: [{ bridgeId: "xiaomi-main" }] }],
        },
      ],
    }),
  } as OnboardingWorldPort;
  const { context, fiber, service } = await coordinator(source);
  try {
    const choices = (service.getState() as unknown as { choices?: {
      status: string;
      bridges: readonly { id: string; label: string; selectable: boolean }[];
      capabilities: readonly { id: string; label: string; bridgeId: string; suggestedPolicyClass: string }[];
    } }).choices;
    assert.equal(choices?.status, "available");
    assert.deepEqual(choices?.bridges.map((item) => [item.id, item.label, item.selectable]), [
      ["custom-main", "openai-compatible", true],
      ["offline-main", "Home Assistant", false],
      ["xiaomi-main", "小米", true],
    ]);
    assert.deepEqual(choices?.capabilities.map((item) => [item.id, item.bridgeId, item.suggestedPolicyClass]), [
      ["cap-lamp", "xiaomi-main", "direct"],
      ["cap-lock", "custom-main", "administrator"],
    ]);
    assert.match(choices?.capabilities[0]?.label ?? "", /客厅主灯/);
    assert.equal(choices?.capabilities.some((item) => item.id === "cap-stale"), false);
  } finally {
    await fiber.dispose();
    await context.fiber.dispose();
  }
});

test("marks onboarding choices unavailable when the world projection is absent", async () => {
  const context = new Context();
  const fiber = await context.plugin(HomeOnboardingCoordinatorService, {
    store: new InMemoryHomeOnboardingStore(),
    now: () => "2026-08-22T00:00:00.000Z",
  });
  try {
    const choices = (context.homeOnboarding.getState() as unknown as { choices?: { status: string; reason?: string } }).choices;
    assert.deepEqual(choices, { status: "unavailable", reason: "world_unavailable", bridges: [], capabilities: [] });
  } finally {
    await fiber.dispose();
    await context.fiber.dispose();
  }
});

test("keeps capabilities out of onboarding when their bridge binding is absent or ambiguous", async () => {
  const source = {
    snapshot: () => ({
      bridges: {
        "bridge-a": { bridgeId: "bridge-a", adapterType: "synthetic-a", diagnostics: { connectionState: "ready" }, watermark: { seq: 1 } },
        "bridge-b": { bridgeId: "bridge-b", adapterType: "synthetic-b", diagnostics: { connectionState: "ready" }, watermark: { seq: 1 } },
      },
      spaces: [],
      devices: [{
        hwId: "device-1",
        validity: "valid",
        capabilities: [
          { hwCapabilityId: "cap-unbound", schema: "boolean" },
          { hwCapabilityId: "cap-ambiguous", schema: "boolean", bindings: [{ bridgeId: "bridge-a" }, { bridgeId: "bridge-b" }] },
        ],
      }],
    }),
  } as OnboardingWorldPort;
  const { context, fiber, service } = await coordinator(source);
  try {
    assert.deepEqual(service.getState().choices.capabilities, []);
  } finally {
    await fiber.dispose();
    await context.fiber.dispose();
  }
});
