import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import test from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  FileHomeCorrectionStore,
  type HomeCorrectionAuditRecord,
  type HomeCorrectionReservationInput,
} from "./home-correction-store.js";

const reservation: HomeCorrectionReservationInput = {
  id: "correction-recovery",
  adviceId: "advice-1",
  actorId: "adult-1",
  correctionType: "future_behavior",
  correction: "以后先询问我是否要延长窗帘的试运行时间。",
  idempotencyKey: "turn-recovery",
  createdAt: "2026-08-22T10:00:00.000Z",
};

const record: HomeCorrectionAuditRecord = {
  ...reservation,
  outcome: "proposal_created",
  destination: "处理中心 · 给家的建议",
  proposalId: "proposal-recovery",
  proposalCount: 1,
};

test("reclaims an expired durable reservation and completes it after a store restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "hob-correction-store-"));
  const path = join(directory, "home-corrections.sqlite");
  const first = new FileHomeCorrectionStore({ path });
  assert.equal(first.reserve(reservation, "owner-old", reservation.createdAt, 1_000).status, "acquired");
  first.close();

  const second = new FileHomeCorrectionStore({ path });
  try {
    const claim = second.reserve(reservation, "owner-new", "2026-08-22T10:00:02.000Z", 1_000);
    assert.equal(claim.status, "acquired");
    assert.deepEqual(second.complete("owner-new", record), record);
    assert.deepEqual(second.findByActorAndIdempotencyKey("adult-1", "turn-recovery"), record);
  } finally {
    second.close();
  }

  const reopened = new FileHomeCorrectionStore({ path });
  try {
    assert.deepEqual(reopened.findByActorAndIdempotencyKey("adult-1", "turn-recovery"), record);
    assert.equal(reopened.listAudit().length, 1);
  } finally {
    reopened.close();
  }
});

test("keeps a live reservation owned until its lease expires", () => {
  const directory = mkdtempSync(join(tmpdir(), "hob-correction-store-"));
  const path = join(directory, "home-corrections.sqlite");
  const store = new FileHomeCorrectionStore({ path });
  try {
    assert.equal(store.reserve(reservation, "owner-a", reservation.createdAt, 10_000).status, "acquired");
    const claim = store.reserve(reservation, "owner-b", "2026-08-22T10:00:01.000Z", 10_000);
    assert.equal(claim.status, "busy");
  } finally {
    store.close();
  }
});
