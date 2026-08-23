import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ProductSessionStore } from "./product-session-store.js";

test("persists a digest-only bound operational session across restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-product-session-"));
  const token = "operational-session-token-with-at-least-thirty-two-bytes";
  const now = new Date("2026-08-24T00:00:00.000Z");
  try {
    const store = new ProductSessionStore(directory, () => now);
    await store.create({
      token,
      principalId: "household-owner",
      deviceId: "setup-browser",
      expiresAt: new Date("2026-09-23T00:00:00.000Z"),
    });

    const reopened = new ProductSessionStore(directory, () => now);
    assert.deepEqual(await reopened.authenticate(token), {
      principalId: "household-owner",
      deviceId: "setup-browser",
    });
    assert.equal(await reopened.authenticate("wrong-operational-session-token-with-at-least-32"), undefined);

    const source = await readFile(join(directory, "product-session.json"), "utf8");
    assert.equal(source.includes(token), false);
    assert.match(source, /"tokenDigest":"[a-f0-9]{64}"/u);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(directory, "product-session.json"))).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("never replaces an existing operational session when a later activation cannot finish", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-product-session-existing-"));
  const now = new Date("2026-08-24T00:00:00.000Z");
  try {
    const store = new ProductSessionStore(directory, () => now);
    await store.create({
      token: "existing-operational-session-token-with-at-least-32",
      principalId: "household-owner",
      deviceId: "setup-browser",
      expiresAt: new Date("2026-09-23T00:00:00.000Z"),
    });
    await assert.rejects(
      store.create({
        token: "replacement-operational-session-token-with-at-least-32",
        principalId: "household-owner",
        deviceId: "setup-browser",
        expiresAt: new Date("2026-09-23T00:00:00.000Z"),
      }),
      /already exists/u,
    );
    assert.notEqual(
      await store.authenticate("existing-operational-session-token-with-at-least-32"),
      undefined,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("creates one operational session across concurrent store instances", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-product-session-concurrent-create-"));
  const now = new Date("2026-08-24T00:00:00.000Z");
  const firstToken = "first-concurrent-session-token-with-at-least-32";
  const secondToken = "second-concurrent-session-token-with-at-least-32";
  try {
    const first = new ProductSessionStore(directory, () => now);
    const second = new ProductSessionStore(directory, () => now);
    const results = await Promise.allSettled([
      first.create({
        token: firstToken,
        principalId: "first-household-owner",
        deviceId: "first-setup-browser",
        expiresAt: new Date("2026-09-23T00:00:00.000Z"),
      }),
      second.create({
        token: secondToken,
        principalId: "second-household-owner",
        deviceId: "second-setup-browser",
        expiresAt: new Date("2026-09-23T00:00:00.000Z"),
      }),
    ]);

    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const winner = results[0]?.status === "fulfilled" ? firstToken : secondToken;
    const loser = winner === firstToken ? secondToken : firstToken;
    assert.notEqual(await new ProductSessionStore(directory, () => now).authenticate(winner), undefined);
    assert.equal(await new ProductSessionStore(directory, () => now).authenticate(loser), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rotates an expired operational session atomically without retaining either token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-product-session-rotate-"));
  let now = new Date("2026-08-24T00:00:00.000Z");
  const oldToken = "expired-operational-session-token-with-at-least-32";
  const newToken = "recovered-operational-session-token-with-at-least-32";
  try {
    const store = new ProductSessionStore(directory, () => now);
    await store.create({
      token: oldToken,
      principalId: "household-owner",
      deviceId: "setup-browser",
      expiresAt: new Date("2026-08-25T00:00:00.000Z"),
    });

    now = new Date("2026-08-26T00:00:00.000Z");
    assert.equal(await store.authenticate(oldToken), undefined);

    await store.rotate({
      token: newToken,
      expiresAt: new Date("2026-11-22T00:00:00.000Z"),
    });

    assert.equal(await store.authenticate(oldToken), undefined);
    assert.deepEqual(await store.authenticate(newToken), {
      principalId: "household-owner",
      deviceId: "setup-browser",
    });
    const source = await readFile(join(directory, "product-session.json"), "utf8");
    assert.equal(source.includes(oldToken), false);
    assert.equal(source.includes(newToken), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("treats malformed browser cookie tokens as unauthenticated", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-product-session-invalid-cookie-"));
  const now = new Date("2026-08-24T00:00:00.000Z");
  try {
    const store = new ProductSessionStore(directory, () => now);
    await store.create({
      token: "valid-operational-session-token-with-at-least-32",
      principalId: "household-owner",
      deviceId: "setup-browser",
      expiresAt: new Date("2026-09-23T00:00:00.000Z"),
    });

    for (const token of ["", "short", "x".repeat(513)]) {
      assert.equal(await store.authenticate(token), undefined);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
