import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SqliteHomeAdviceStore } from "./home-advice-store.js";

const report = {
  summary: "Try a daylight-aware schedule first.",
  confidence: "partial" as const,
  findings: ["The opening time is fixed."],
  unknowns: ["Indoor brightness is unavailable."],
  trial: {
    description: "Use a sunrise-based bounded schedule.",
    durationDays: 14,
    successCriteria: ["Fewer manual reversals."],
    rollback: "Restore the fixed schedule.",
  },
  hardwareSuggestions: [{
    capability: "illuminance" as const,
    necessity: "optional" as const,
    reason: "It observes actual daylight.",
    placement: "Near the window.",
    privacyImpact: "low" as const,
    alternative: "Use sunrise and weather data.",
  }],
  validationSteps: ["Review after two weeks."],
};

test("persists private bounded household questions and structured reports", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-advice-store-"));
  const path = join(directory, "advice.sqlite");
  const store = new SqliteHomeAdviceStore({
    path,
    idFactory: () => "advice-1",
  });

  const id = store.begin({ question: "Why is the curtain timing uncomfortable?", createdAt: "2026-08-20T10:00:00.000Z" });
  store.complete({ id, report, completedAt: "2026-08-20T10:00:02.000Z" });

  assert.deepEqual(store.get(id), {
    id,
    status: "completed",
    question: "Why is the curtain timing uncomfortable?",
    createdAt: "2026-08-20T10:00:00.000Z",
    completedAt: "2026-08-20T10:00:02.000Z",
    report,
  });
  assert.deepEqual(store.list({ limit: 5 }).map((item) => item.id), [id]);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  store.close();
});

test("fails a running request without persisting raw provider errors", () => {
  const store = new SqliteHomeAdviceStore({ path: ":memory:", idFactory: () => "advice-failed" });
  const id = store.begin({ question: "Should I add a sensor?", createdAt: "2026-08-20T10:00:00.000Z" });
  store.fail({ id, completedAt: "2026-08-20T10:00:01.000Z" });

  assert.deepEqual(store.get(id), {
    id,
    status: "failed",
    question: "Should I add a sensor?",
    createdAt: "2026-08-20T10:00:00.000Z",
    completedAt: "2026-08-20T10:00:01.000Z",
  });
  assert.throws(() => store.begin({ question: "x".repeat(1_001), createdAt: "2026-08-20T10:00:02.000Z" }), /question/i);
  store.close();
});
