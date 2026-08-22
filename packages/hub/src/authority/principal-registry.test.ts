import assert from "node:assert/strict";
import test from "node:test";

test("resolves bridge-salted opaque principal refs without exposing platform user ids", async () => {
  const modulePath = new URL("./principal-registry.js", import.meta.url).href;
  const loaded = await import(modulePath).catch(() => undefined) as {
    PrincipalRegistry?: new () => { resolve(bridgeId: string, platformUserId: string): string };
  } | undefined;
  assert.ok(loaded?.PrincipalRegistry, "PrincipalRegistry is not implemented");
  if (loaded?.PrincipalRegistry === undefined) return;

  const registry = new loaded.PrincipalRegistry();
  const first = registry.resolve("bridge-a", "platform-user-123");
  const repeated = registry.resolve("bridge-a", "platform-user-123");
  const otherBridge = registry.resolve("bridge-b", "platform-user-123");

  assert.match(first, /^pr:[0-9a-f]{64}$/);
  assert.equal(repeated, first);
  assert.notEqual(otherBridge, first);
  assert.equal(first.includes("platform-user-123"), false);
  assert.equal(JSON.stringify(registry).includes("platform-user-123"), false);
});
