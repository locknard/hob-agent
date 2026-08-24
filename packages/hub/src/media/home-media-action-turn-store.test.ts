import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { SqliteHomeMediaActionTurnStore } from "./home-media-action-turn-store.js";

const createdAt = "2026-08-24T00:00:00.000Z";
const transitionedAt = "2026-08-24T00:00:01.000Z";

test("deduplicates a server-issued idempotency key without creating a second accepted event", () => {
  let idCalls = 0;
  const store = new SqliteHomeMediaActionTurnStore({
    path: ":memory:",
    idFactory: () => {
      idCalls += 1;
      return idCalls === 1 ? "turn-idempotent" : "invalid id";
    },
  });
  const input = {
    createdAt,
    idempotencyKey: "0123456789abcdef0123456789abcdef",
    question: "播放晚间爵士",
  };

  const firstResult = store.begin(input);
  const repeatedResult = store.begin(input);
  const first = firstResult.turn;
  const repeated = repeatedResult.turn;

  assert.equal(firstResult.outcome, "created");
  assert.equal(repeatedResult.outcome, "existing");
  assert.deepEqual(repeated, first);
  assert.equal(first.question, "播放晚间爵士");
  assert.equal(idCalls, 1);
  assert.equal(first.requestId, "media-action:0123456789abcdef0123456789abcdef");
  assert.equal(store.events(first.id).length, 1);
  assert.throws(() => store.begin({ ...input, question: "播放清晨爵士" } as never), /conflict/i);
  assert.deepEqual(store.get(first.id), first);
  store.close();
});

test("replays an existing idempotency key without creating durable state", () => {
  const store = new SqliteHomeMediaActionTurnStore({ path: ":memory:", idFactory: () => "turn-replay" });
  const input = {
    createdAt,
    idempotencyKey: "fedcba9876543210fedcba9876543210",
    question: "播放晚间爵士",
  };
  const turn = store.begin(input).turn;

  assert.deepEqual(store.replay({
    idempotencyKey: input.idempotencyKey,
    question: input.question,
  }), turn);
  assert.equal(store.events(turn.id).length, 1);
  assert.equal(store.replay({
    idempotencyKey: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    question: input.question,
  }), undefined);
  assert.throws(() => store.replay({
    idempotencyKey: input.idempotencyKey,
    question: "播放清晨爵士",
  }), /conflict/i);
  assert.equal(store.events(turn.id).length, 1);
  store.close();
});

test("begins an action turn and its accepted event in one durable transaction", () => {
  const store = new SqliteHomeMediaActionTurnStore({ path: ":memory:", idFactory: () => "turn-1" });

  const turn = begin(store, "11111111111111111111111111111111");

  assert.deepEqual(turn, {
    id: "turn-1",
    idempotencyKey: "11111111111111111111111111111111",
    requestId: "media-action:11111111111111111111111111111111",
    question: "播放晚间爵士",
    createdAt,
    status: "running",
  });
  assert.deepEqual(store.events(turn.id), [{
    seq: 1,
    type: "accepted",
    at: createdAt,
  }]);
  store.close();
});

test("rolls back the action-turn row when its accepted event cannot be written", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-media-action-turn-atomic-"));
  const path = join(directory, "turns.sqlite");
  const store = new SqliteHomeMediaActionTurnStore({ path, idFactory: () => "turn-atomic" });
  const db = (store as unknown as { db: DatabaseSync }).db;
  db.exec(`CREATE TRIGGER fail_accepted BEFORE INSERT ON home_media_action_turn_events
    WHEN NEW.lifecycle_kind = 'accepted' BEGIN SELECT RAISE(ABORT, 'accepted write failed'); END;`);

  assert.throws(() => begin(store, "22222222222222222222222222222222"), /accepted write failed/i);
  assert.equal(store.get("turn-atomic"), undefined);
  assert.equal(store.findByRequestId("media-action:22222222222222222222222222222222"), undefined);
  store.close();
});

test("allows exactly one concurrent running transition across store connections", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-media-action-turn-cas-"));
  const path = join(directory, "turns.sqlite");
  const first = new SqliteHomeMediaActionTurnStore({ path, idFactory: () => "turn-cas" });
  const second = new SqliteHomeMediaActionTurnStore({ path });
  const turn = begin(first, "33333333333333333333333333333333");

  assert.equal(first.clarify({
    id: turn.id,
    clarification: clarification(),
    transitionedAt,
  }), true);
  assert.equal(second.fail({
    id: turn.id,
    reason: "agent_unavailable",
    transitionedAt: "2026-08-24T00:00:02.000Z",
  }), false);
  assert.equal(second.get(turn.id)?.status, "clarification");
  assert.deepEqual(second.events(turn.id).map((event) => event.type), ["accepted", "clarification"]);
  first.close();
  second.close();
});

test("persists only a bounded safe clarification projection", () => {
  const store = new SqliteHomeMediaActionTurnStore({ path: ":memory:", idFactory: () => "turn-clarification" });
  const turn = begin(store, "44444444444444444444444444444444");
  const value = clarification();

  assert.equal(store.clarify({ id: turn.id, clarification: value, transitionedAt }), true);
  assert.deepEqual(store.get(turn.id), {
    ...turn,
    status: "clarification",
    clarification: value,
    transitionedAt,
  });
  assert.throws(() => store.clarify({
    id: "turn-invalid",
    clarification: { ...value, options: [{ title: "x".repeat(201) }] },
    transitionedAt,
  }), /title/i);
  store.close();
});

test("stores an existing ticket identifier without duplicating ticket state", () => {
  const store = new SqliteHomeMediaActionTurnStore({ path: ":memory:", idFactory: () => "turn-ticket" });
  const turn = begin(store, "55555555555555555555555555555555");

  assert.equal(store.ticket({ id: turn.id, ticketId: "ticket-1", transitionedAt }), true);
  assert.deepEqual(store.get(turn.id), {
    ...turn,
    status: "ticket",
    ticketId: "ticket-1",
    transitionedAt,
  });
  store.close();
});

test("records the local product question without actor, presence, device, or secret data", () => {
  const store = new SqliteHomeMediaActionTurnStore({
    path: ":memory:",
    idFactory: (() => {
      const ids = ["turn-failed", "turn-cancelled"];
      return () => ids.shift()!;
    })(),
  });
  const failed = begin(store, "66666666666666666666666666666666");
  const cancelled = begin(store, "77777777777777777777777777777777");

  assert.equal(store.fail({ id: failed.id, reason: "interrupted_before_action", transitionedAt }), true);
  assert.equal(store.cancel({ id: cancelled.id, transitionedAt }), true);
  assert.deepEqual(store.get(failed.id), {
    ...failed,
    status: "failed",
    reason: "interrupted_before_action",
    transitionedAt,
  });
  assert.deepEqual(store.get(cancelled.id), {
    ...cancelled,
    status: "cancelled",
    reason: "cancelled_before_action",
    transitionedAt,
  });
  const raw = JSON.stringify(store.get(failed.id));
  assert.doesNotMatch(raw, /actor|presence|device|secret/i);
  const db = (store as unknown as { db: DatabaseSync }).db;
  const columns = (db.prepare("PRAGMA table_info(home_media_action_turns)").all() as Array<{ name: string }>).map((row) => row.name);
  assert.equal(columns.includes("question"), true);
  assert.equal(columns.some((name) => /^(actor|presence|device|secret)$/i.test(name)), false);
  assert.equal((db.prepare("SELECT question FROM home_media_action_turns WHERE turn_id = ?").get(failed.id) as { question: string }).question,
    "播放晚间爵士");
  store.close();
});

test("normalizes the displayed question and rejects a stored question whose digest does not match", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-media-action-turn-question-"));
  const path = join(directory, "turns.sqlite");
  const first = new SqliteHomeMediaActionTurnStore({ path, idFactory: () => "turn-question" });
  const created = first.begin({
    createdAt,
    idempotencyKey: "abababababababababababababababab",
    question: "  播放晚间爵士  ",
  }).turn;
  assert.equal(created.question, "播放晚间爵士");
  first.close();

  const reopened = new SqliteHomeMediaActionTurnStore({ path });
  assert.equal(reopened.get(created.id)?.question, "播放晚间爵士");
  reopened.close();

  const tamper = new DatabaseSync(path);
  tamper.prepare("UPDATE home_media_action_turns SET question = ? WHERE turn_id = ?")
    .run("播放清晨爵士", created.id);
  tamper.close();
  const corrupted = new SqliteHomeMediaActionTurnStore({ path });
  assert.throws(() => corrupted.get(created.id), /corrupt/i);
  corrupted.close();
});

test("reopens turns and accepts only well-formed persisted state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-media-action-turn-reopen-"));
  const path = join(directory, "turns.sqlite");
  const first = new SqliteHomeMediaActionTurnStore({ path, idFactory: () => "turn-reopen" });
  const turn = begin(first, "88888888888888888888888888888888");
  first.ticket({ id: turn.id, ticketId: "ticket-reopen", transitionedAt });
  first.close();

  const reopened = new SqliteHomeMediaActionTurnStore({ path });
  assert.deepEqual(reopened.findByRequestId(turn.requestId), {
    ...turn,
    status: "ticket",
    ticketId: "ticket-reopen",
    transitionedAt,
  });
  reopened.close();

  const corrupt = new DatabaseSync(path);
  corrupt.prepare("UPDATE home_media_action_turns SET detail_json = ? WHERE turn_id = ?")
    .run('{"status":"clarification","slot":"bad"}', turn.id);
  corrupt.close();
  const corrupted = new SqliteHomeMediaActionTurnStore({ path });
  assert.throws(() => corrupted.get(turn.id), /corrupt/i);
  corrupted.close();
});

test("retains a bounded replay window with a monotonic cursor", () => {
  const store = new SqliteHomeMediaActionTurnStore({
    path: ":memory:",
    idFactory: (() => {
      const ids = ["turn-events-1", "turn-events-2", "turn-events-3"];
      return () => ids.shift()!;
    })(),
    maxEventsPerTurn: 1,
  });
  const first = begin(store, "99999999999999999999999999999999");
  store.fail({ id: first.id, reason: "invalid_result", transitionedAt });
  const second = begin(store, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "2026-08-24T00:00:02.000Z");
  store.cancel({ id: second.id, transitionedAt: "2026-08-24T00:00:03.000Z" });

  assert.deepEqual(store.events(first.id), [{ seq: 2, type: "failed", at: transitionedAt }]);
  assert.deepEqual(store.events(first.id, 1), [{ seq: 2, type: "failed", at: transitionedAt }]);
  assert.deepEqual(store.events(first.id, 2), []);
  assert.deepEqual(store.recoverable().map((turn) => turn.id), []);
  store.close();
});

test("rejects duplicate request identifiers and malformed external inputs", () => {
  const store = new SqliteHomeMediaActionTurnStore({ path: ":memory:", idFactory: () => "same-id" });
  begin(store, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  assert.throws(() => store.begin({
    createdAt,
    idempotencyKey: "cccccccccccccccccccccccccccccccc",
    question: "播放晚间爵士",
  }), /unique|constraint/i);
  assert.throws(() => store.begin({
    createdAt: "not-a-time",
    idempotencyKey: "dddddddddddddddddddddddddddddddd",
    question: "播放晚间爵士",
  }), /time/i);
  assert.throws(() => store.events("same-id", -1), /cursor/i);
  assert.throws(() => store.fail({
    id: "same-id",
    reason: "provider error text" as never,
    transitionedAt,
  }), /reason/i);
  store.close();
});

test("durably queues only clarification and failed media turn completions with a minimal payload", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-media-action-turn-notifications-"));
  const path = join(directory, "turns.sqlite");
  const first = new SqliteHomeMediaActionTurnStore({
    path,
    idFactory: (() => {
      const ids = ["turn-clarification-notification", "turn-ticket-notification", "turn-timeout-notification", "turn-cancelled-notification"];
      return () => ids.shift()!;
    })(),
  });
  const clarificationTurn = begin(first, "cccccccccccccccccccccccccccccccc", "2026-08-24T00:00:00.000Z");
  const ticketTurn = begin(first, "dddddddddddddddddddddddddddddddd", "2026-08-24T00:00:00.000Z");
  const timedOutTurn = begin(first, "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", "2026-08-24T00:00:00.000Z");
  const cancelledTurn = begin(first, "ffffffffffffffffffffffffffffffff", "2026-08-24T00:00:00.000Z");

  assert.equal(first.clarify({
    id: clarificationTurn.id,
    clarification: clarification(),
    transitionedAt: "2026-08-24T00:00:01.000Z",
  }), true);
  assert.equal(first.ticket({
    id: ticketTurn.id,
    ticketId: "ticket-private",
    transitionedAt: "2026-08-24T00:00:02.000Z",
  }), true);
  assert.equal(first.fail({
    id: timedOutTurn.id,
    reason: "timed_out",
    transitionedAt: "2026-08-24T00:00:03.000Z",
  }), true);
  assert.equal(first.cancel({ id: cancelledTurn.id, transitionedAt: "2026-08-24T00:00:04.000Z" }), true);

  const reopened = new SqliteHomeMediaActionTurnStore({ path });
  assert.deepEqual(reopened.peekNextCompletionNotification(), {
    turnId: clarificationTurn.id,
    status: "clarification",
    completedAt: "2026-08-24T00:00:01.000Z",
  });
  assert.deepEqual(reopened.peekNextCompletionNotification(), {
    turnId: clarificationTurn.id,
    status: "clarification",
    completedAt: "2026-08-24T00:00:01.000Z",
  });
  assert.deepEqual(Object.keys(reopened.peekNextCompletionNotification() ?? {}).sort(), ["completedAt", "status", "turnId"]);
  assert.equal(reopened.acknowledgeCompletionNotification(clarificationTurn.id), true);
  assert.equal(reopened.acknowledgeCompletionNotification(clarificationTurn.id), false);
  assert.equal(reopened.acknowledgeCompletionNotification(ticketTurn.id), false);
  assert.equal(reopened.acknowledgeCompletionNotification(cancelledTurn.id), false);
  assert.deepEqual(first.peekNextCompletionNotification(), {
    turnId: timedOutTurn.id,
    status: "failed",
    completedAt: "2026-08-24T00:00:03.000Z",
  });
  assert.equal(reopened.acknowledgeCompletionNotification(timedOutTurn.id), true);
  assert.equal(reopened.peekNextCompletionNotification(), undefined);
  first.close();
  reopened.close();
});

test("keeps terminal notification creation atomic and never duplicates a replayed terminal transition", () => {
  const store = new SqliteHomeMediaActionTurnStore({ path: ":memory:", idFactory: () => "turn-notification-atomic" });
  const turn = begin(store, "12121212121212121212121212121212");
  const db = (store as unknown as { db: DatabaseSync }).db;
  db.exec(`CREATE TRIGGER fail_completion_notification BEFORE UPDATE OF completion_notification_pending ON home_media_action_turns
    WHEN NEW.status = 'clarification' BEGIN SELECT RAISE(ABORT, 'completion notification write failed'); END;`);

  assert.throws(() => store.clarify({ id: turn.id, clarification: clarification(), transitionedAt }), /completion notification write failed/i);
  assert.equal(store.get(turn.id)?.status, "running");
  assert.equal(store.peekNextCompletionNotification(), undefined);
  db.exec("DROP TRIGGER fail_completion_notification");
  assert.equal(store.clarify({ id: turn.id, clarification: clarification(), transitionedAt }), true);
  assert.equal(store.clarify({ id: turn.id, clarification: clarification(), transitionedAt: "2026-08-24T00:00:02.000Z" }), false);
  assert.equal(store.replay({ idempotencyKey: "12121212121212121212121212121212", question: "播放晚间爵士" })?.status, "clarification");
  assert.deepEqual(store.peekNextCompletionNotification(), {
    turnId: turn.id,
    status: "clarification",
    completedAt: transitionedAt,
  });
  store.close();
});

function clarification() {
  return {
    status: "clarification" as const,
    slot: "queueMode" as const,
    reason: "missing" as const,
    options: [{ queueMode: "replace_and_play" as const }],
  };
}

function begin(
  store: SqliteHomeMediaActionTurnStore,
  idempotencyKey: string,
  createdAtOverride = createdAt,
) {
  return store.begin({
    createdAt: createdAtOverride,
    idempotencyKey,
    question: "播放晚间爵士",
  }).turn;
}
