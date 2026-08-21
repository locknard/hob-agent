import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
  assert.deepEqual(store.peekNextCompletionNotification(), {
    adviceId: id,
    status: "failed",
    completedAt: "2026-08-20T10:00:01.000Z",
    eventId: 1,
  });
  assert.equal(store.acknowledgeCompletionNotification(id), true);
  assert.equal(store.peekNextCompletionNotification(), undefined);
  assert.throws(() => store.begin({ question: "x".repeat(1_001), createdAt: "2026-08-20T10:00:02.000Z" }), /question/i);
  store.close();
});

test("atomically moves one running advice into background and explicitly acknowledges its terminal notification", () => {
  const store = new SqliteHomeAdviceStore({ path: ":memory:", idFactory: () => "advice-background" });
  const id = store.begin({ question: "Should I add a sensor?", createdAt: "2026-08-20T10:00:00.000Z" });

  store.appendProgress({ id, type: "accepted", at: "2026-08-20T10:00:00.000Z" });
  assert.equal(store.background({ id, backgroundAt: "2026-08-20T10:00:01.000Z" }), true);
  assert.deepEqual(store.get(id), {
    id,
    question: "Should I add a sensor?",
    status: "background",
    createdAt: "2026-08-20T10:00:00.000Z",
    backgroundAt: "2026-08-20T10:00:01.000Z",
  });
  assert.equal(store.background({ id, backgroundAt: "2026-08-20T10:00:02.000Z" }), false);

  assert.deepEqual(store.events(id).map((event) => [event.id, event.type]), [[1, "accepted"], [2, "background"]]);

  assert.equal(store.complete({ id, report, completedAt: "2026-08-20T10:00:03.000Z" }), true);
  assert.equal(store.fail({ id, completedAt: "2026-08-20T10:00:04.000Z" }), false);
  assert.deepEqual(store.peekNextCompletionNotification(), {
    adviceId: id,
    status: "completed",
    completedAt: "2026-08-20T10:00:03.000Z",
    eventId: 3,
  });
  assert.equal(store.acknowledgeCompletionNotification(id), true);
  assert.equal(store.peekNextCompletionNotification(), undefined);
  store.close();
});

test("reopens a background advice with its durable bounded event cursor", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-advice-background-"));
  const path = join(directory, "advice.sqlite");
  const first = new SqliteHomeAdviceStore({ path, idFactory: () => "advice-reopen", maxProgressEventsPerAdvice: 2 });
  const id = first.begin({ question: "Why did the window open?", createdAt: "2026-08-20T10:00:00.000Z" });
  first.appendProgress({ id, type: "accepted", at: "2026-08-20T10:00:00.000Z" });
  assert.equal(first.background({ id, backgroundAt: "2026-08-20T10:00:01.000Z" }), true);
  first.appendProgress({ id, type: "composing_answer", at: "2026-08-20T10:00:02.000Z" });
  first.close();

  const reopened = new SqliteHomeAdviceStore({ path, maxProgressEventsPerAdvice: 2 });
  assert.equal(reopened.get(id)?.status, "background");
  assert.deepEqual(reopened.events(id).map((event) => [event.id, event.type]), [[2, "background"], [3, "composing_answer"]]);
  reopened.close();
});

test("upgrades the legacy advice table while preserving terminal records", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-advice-store-migration-"));
  const path = join(directory, "advice.sqlite");
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE home_advice (
    advice_id TEXT PRIMARY KEY,
    question TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
    report_json TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT,
    CHECK ((status = 'running' AND report_json IS NULL AND completed_at IS NULL)
      OR (status = 'failed' AND report_json IS NULL AND completed_at IS NOT NULL)
      OR (status = 'completed' AND report_json IS NOT NULL AND completed_at IS NOT NULL))
  ) STRICT;
  CREATE INDEX home_advice_created ON home_advice (created_at DESC, advice_id DESC);`);
  legacy.prepare(`INSERT INTO home_advice
    (advice_id, question, status, report_json, created_at, completed_at)
    VALUES (?, ?, 'completed', ?, ?, ?)`).run(
    "advice-legacy",
    "Why did the window open?",
    JSON.stringify(report),
    "2026-08-20T10:00:00.000Z",
    "2026-08-20T10:00:01.000Z",
  );
  legacy.close();

  const store = new SqliteHomeAdviceStore({ path, idFactory: () => "advice-after-migration" });
  assert.equal(store.get("advice-legacy")?.status, "completed");
  const id = store.begin({ question: "Can this store background?", createdAt: "2026-08-20T10:00:02.000Z" });
  store.appendProgress({ id, type: "accepted", at: "2026-08-20T10:00:02.000Z" });
  assert.equal(store.background({ id, backgroundAt: "2026-08-20T10:00:03.000Z" }), true);
  assert.equal(store.get(id)?.status, "background");
  store.close();
});

test("peeks and acknowledges completion notifications in oldest order across store connections", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-advice-notifications-"));
  const path = join(directory, "advice.sqlite");
  const first = new SqliteHomeAdviceStore({
    path,
    idFactory: (() => {
      const ids = ["advice-a", "advice-b", "advice-c"];
      return () => ids.shift()!;
    })(),
  });
  const a = first.begin({ question: "Question A", createdAt: "2026-08-20T10:00:00.000Z" });
  const b = first.begin({ question: "Question B", createdAt: "2026-08-20T10:00:00.000Z" });
  const c = first.begin({ question: "Question C", createdAt: "2026-08-20T10:00:00.000Z" });
  first.complete({ id: a, report, completedAt: "2026-08-20T10:00:03.000Z" });
  first.fail({ id: b, completedAt: "2026-08-20T10:00:01.000Z" });
  first.complete({ id: c, report, completedAt: "2026-08-20T10:00:01.000Z" });

  const second = new SqliteHomeAdviceStore({ path });
  assert.deepEqual(first.peekNextCompletionNotification(), {
    adviceId: b,
    status: "failed",
    completedAt: "2026-08-20T10:00:01.000Z",
    eventId: 1,
  });
  assert.deepEqual(second.peekNextCompletionNotification(), {
    adviceId: b,
    status: "failed",
    completedAt: "2026-08-20T10:00:01.000Z",
    eventId: 1,
  });
  assert.equal(second.acknowledgeCompletionNotification(b), true);
  assert.deepEqual(first.peekNextCompletionNotification(), {
    adviceId: c,
    status: "completed",
    completedAt: "2026-08-20T10:00:01.000Z",
    eventId: 1,
  });
  assert.equal(first.acknowledgeCompletionNotification(c), true);
  assert.deepEqual(first.peekNextCompletionNotification(), {
    adviceId: a,
    status: "completed",
    completedAt: "2026-08-20T10:00:03.000Z",
    eventId: 1,
  });
  assert.equal(second.acknowledgeCompletionNotification(a), true);
  assert.equal(second.peekNextCompletionNotification(), undefined);
  assert.equal(first.acknowledgeCompletionNotification(b), false);
  assert.equal(first.background({ id: a, backgroundAt: "2026-08-20T10:00:04.000Z" }), false);
  assert.equal(first.fail({ id: c, completedAt: "2026-08-20T10:00:04.000Z" }), false);
  first.close();
  second.close();
});

test("peeks a completion notification until the product explicitly acknowledges it", () => {
  const store = new SqliteHomeAdviceStore({ path: ":memory:", idFactory: () => "advice-peek" });
  const id = store.begin({ question: "Question", createdAt: "2026-08-20T10:00:00.000Z" });
  store.complete({ id, report, completedAt: "2026-08-20T10:00:01.000Z" });
  const first = store.peekNextCompletionNotification();
  assert.equal(first?.adviceId, id);
  assert.deepEqual(store.peekNextCompletionNotification(), first);
  assert.equal(store.acknowledgeCompletionNotification(id), true);
  assert.equal(store.peekNextCompletionNotification(), undefined);
  assert.equal(store.acknowledgeCompletionNotification(id), false);
  store.close();
});
