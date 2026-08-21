import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { InMemoryHomeSafetyStore, SqliteHomeSafetyStore } from "./home-safety-store.js";

const record = {
  id: "leak:1",
  bindingId: "leak",
  hwCapabilityId: "hwc-leak",
  kind: "water_leak" as const,
  status: "acknowledged" as const,
  firstObservedAt: "2026-08-22T08:00:00.000Z",
  lastObservedAt: "2026-08-22T08:01:00.000Z",
  acknowledgedAt: "2026-08-22T08:01:00.000Z",
  acknowledgedBy: "adult-1",
};

test("safety store clones and preserves incident records", () => {
  const store = new InMemoryHomeSafetyStore();
  store.save([{
    ...record,
  }]);
  const loaded = store.load();
  assert.equal(loaded[0]?.status, "acknowledged");
  assert.notEqual(loaded, store.load());
});

test("sqlite safety store persists incidents across service lifecycles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-home-safety-"));
  const path = join(directory, "home-safety.sqlite");
  try {
    const first = new SqliteHomeSafetyStore({ path });
    first.save([record]);
    first.close();

    const second = new SqliteHomeSafetyStore({ path });
    assert.deepEqual(second.load(), [record]);
    second.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("safety store validates incident identity and status", () => {
  const store = new InMemoryHomeSafetyStore();
  assert.throws(() => store.save([{
    id: "",
    bindingId: "leak",
    hwCapabilityId: "hwc-leak",
    kind: "water_leak",
    status: "active",
    firstObservedAt: "2026-08-22T08:00:00.000Z",
    lastObservedAt: "2026-08-22T08:00:00.000Z",
  }]), /Home safety alert record is invalid/);
});
