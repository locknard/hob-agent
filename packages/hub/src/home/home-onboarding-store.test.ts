import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FileHomeOnboardingStore,
  InMemoryHomeOnboardingStore,
  initialHomeOnboardingState,
  parseHomeOnboardingState,
} from "./home-onboarding-store.js";

test("stores the typed onboarding state durably without accepting arbitrary form fields", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-home-onboarding-store-"));
  const path = join(directory, "onboarding.sqlite");
  try {
    const first = new FileHomeOnboardingStore({ path });
    const state = initialHomeOnboardingState("2026-08-22T00:00:00.000Z");
    first.save({
      ...state,
      household: { householdName: "小海的家", agentName: "阿灶" },
      steps: {
        ...state.steps,
        1: {
          status: "completed",
          updatedAt: "2026-08-22T00:01:00.000Z",
          summary: "家庭和助手已经命名。",
        },
      },
      currentStep: 2,
      completedSteps: [1],
      updatedAt: "2026-08-22T00:01:00.000Z",
    });
    const reopened = new FileHomeOnboardingStore({ path });
    assert.deepEqual(reopened.load().household, { householdName: "小海的家", agentName: "阿灶" });
    assert.equal(reopened.load().currentStep, 2);
    assert.equal((await readFile(path)).includes("token"), false);
    first.close();
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("persists the accepted first-question advice id with the onboarding checkpoint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-home-onboarding-first-question-store-"));
  const path = join(directory, "onboarding.sqlite");
  try {
    const first = new FileHomeOnboardingStore({ path });
    const initial = initialHomeOnboardingState("2026-08-22T00:00:00.000Z");
    const steps = Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8].map((step) => [step, {
      status: "completed",
      updatedAt: "2026-08-22T00:01:00.000Z",
      summary: "已完成",
    }])) as typeof initial.steps;
    first.save({
      ...initial,
      currentStep: 8,
      completedSteps: [1, 2, 3, 4, 5, 6, 7, 8],
      complete: true,
      updatedAt: "2026-08-22T00:01:00.000Z",
      steps,
      firstQuestion: {
        question: "家里现在怎么样？",
        adviceId: "advice-store-1",
        acceptedAt: "2026-08-22T00:01:00.000Z",
      },
    });
    first.close();

    const reopened = new FileHomeOnboardingStore({ path });
    assert.deepEqual(reopened.load()?.firstQuestion, {
      question: "家里现在怎么样？",
      adviceId: "advice-store-1",
      acceptedAt: "2026-08-22T00:01:00.000Z",
    });
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects impossible onboarding states and unknown persisted step data", () => {
  assert.throws(
    () => parseHomeOnboardingState({
      ...initialHomeOnboardingState("2026-08-22T00:00:00.000Z"),
      currentStep: 4,
      completedSteps: [1, 2],
      steps: {
        1: { status: "completed", updatedAt: "2026-08-22T00:00:00.000Z", summary: "done" },
        2: { status: "completed", updatedAt: "2026-08-22T00:00:00.000Z", summary: "done" },
        9: { status: "completed", updatedAt: "2026-08-22T00:00:00.000Z", summary: "foreign" },
      },
    }),
    /invalid/i,
  );
  assert.equal(new InMemoryHomeOnboardingStore().load(), undefined);
});
