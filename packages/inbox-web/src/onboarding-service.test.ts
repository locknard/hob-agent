import assert from "node:assert/strict";
import test from "node:test";

import {
  UnavailableOnboardingService,
  type OnboardingCommand,
  type OnboardingPort,
} from "./onboarding-service.js";

test("Inbox exposes the typed command seam and keeps an omitted Hub owner explicitly blocked", () => {
  const service = new UnavailableOnboardingService();
  assert.equal(service.getState().status, "blocked");
  assert.equal(service.getState().body, "家庭设置正在准备，连接完成后从这里继续。");
  assert.doesNotMatch(service.getState().body, /运行时|runtime|启动完整/iu);
  assert.throws(() => service.submit({
    step: 1,
    kind: "name_household",
    householdName: "家",
    agentName: "助手",
  }), /unavailable/i);
});

test("a typed onboarding port receives a command and authenticated actor as separate values", async () => {
  const calls: unknown[] = [];
  const port: OnboardingPort = {
    getState: () => ({ step: 1, complete: false, status: "ready", title: "起名", body: "起名" }),
    submit: async (command, actor) => {
      calls.push({ command, actor });
      return { state: { step: 2, complete: false, status: "ready", title: "接桥", body: "接桥" }, outcome: "completed", complete: false, completedStep: 1 };
    },
  };
  const command: OnboardingCommand = { step: 1, kind: "name_household", householdName: "家", agentName: "助手" };
  await port.submit(command, {
    principalId: "adult-1",
    role: "adult_member",
    present: true,
    device: { kind: "private", boundPrincipalId: "adult-1" },
  });
  assert.equal((calls[0] as { command: OnboardingCommand }).command.kind, "name_household");
  assert.equal((calls[0] as { actor: { principalId: string } }).actor.principalId, "adult-1");
});
