import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ProductSetupRuntime } from "./product-setup-runtime.js";

test("owns one guarded Cordis setup lifecycle and announces its reachable page once", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "hob-setup-runtime-"));
  const announcements: unknown[] = [];
  const runtime = new ProductSetupRuntime({
    dataDirectory,
    port: 0,
    pairingCode: "LIVE-HOME",
    now: () => new Date("2026-08-23T02:00:00.000Z"),
    createSessionToken: () => "runtime-private-setup-session-token-value",
    announce: (announcement) => { announcements.push(announcement); },
  });
  try {
    assert.equal(runtime.status, "created");
    await runtime.start();
    assert.equal(runtime.status, "running");
    assert.equal(announcements.length, 1);
    assert.match(runtime.context.productSetupHttp.origin, /^http:\/\/127\.0\.0\.1:\d+$/u);
    assert.equal((await fetch(`${runtime.context.productSetupHttp.origin}/setup`)).status, 200);
    await assert.rejects(runtime.start(), /cannot start from running/);
    await Promise.all([runtime.stop(), runtime.stop()]);
    assert.equal(runtime.status, "stopped");
  } finally {
    await runtime.stop();
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("disposes the listener when setup announcement fails", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "hob-setup-runtime-failure-"));
  const runtime = new ProductSetupRuntime({
    dataDirectory,
    port: 0,
    pairingCode: "FAIL-HOME",
    announce: () => { throw new Error("announcement unavailable"); },
  });
  try {
    await assert.rejects(runtime.start(), /announcement unavailable/);
    assert.equal(runtime.status, "stopped");
  } finally {
    await runtime.stop();
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("allows only one setup process to own a private data directory", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "hob-setup-runtime-owner-"));
  const first = new ProductSetupRuntime({ dataDirectory, port: 0, announce: () => undefined });
  const second = new ProductSetupRuntime({ dataDirectory, port: 0, announce: () => undefined });
  try {
    await first.start();
    await assert.rejects(second.start(), /already running for this home/);
    await first.stop();
    const replacement = new ProductSetupRuntime({ dataDirectory, port: 0, announce: () => undefined });
    await replacement.start();
    await replacement.stop();
  } finally {
    await first.stop();
    await second.stop();
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
