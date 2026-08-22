import assert from "node:assert/strict";
import test from "node:test";

import {
  CredentialKindMismatchError,
  createScopedBridgeCredentialProvider,
  type CredentialMaterial,
} from "./bridge-credentials.js";

test("scopes credential resolution to declared aliases and kinds", async () => {
  const calls: string[] = [];
  const materials = new Map<string, CredentialMaterial>([
    ["ha-token", { kind: "secret_text", value: "do-not-leak" }],
    ["oauth", { kind: "oauth", accessToken: "access" }],
  ]);
  const provider = createScopedBridgeCredentialProvider({
    bridgeId: "bridge-a",
    requirements: [
      { alias: "ha-token", kind: "secret_text" },
      { alias: "oauth", kind: "oauth" },
    ],
    source: {
      async resolve(alias: string) {
        calls.push(alias);
        return materials.get(alias);
      },
      async describe(alias: string) {
        calls.push(`describe:${alias}`);
        return { configured: materials.has(alias) };
      },
    },
  });

  assert.deepEqual(await provider.resolve("ha-token"), materials.get("ha-token"));
  assert.equal(await provider.resolve("other-bridge-token"), undefined);
  assert.deepEqual(await provider.describe("other-bridge-token"), { configured: false });
  assert.deepEqual(calls, ["ha-token"]);
});

test("fails closed when the vault material kind does not match its requirement", async () => {
  const provider = createScopedBridgeCredentialProvider({
    bridgeId: "bridge-a",
    requirements: [{ alias: "token", kind: "secret_text" }],
    source: {
      async resolve() {
        return { kind: "oauth", accessToken: "secret-access-token" } as CredentialMaterial;
      },
      async describe() {
        return { configured: true };
      },
    },
  });

  await assert.rejects(
    provider.resolve("token"),
    (error: unknown) => error instanceof CredentialKindMismatchError
      && !error.message.includes("secret-access-token"),
  );
});

test("binds a scoped provider to a bridge-aware vault without exposing enumeration", async () => {
  const calls: Array<[string, string]> = [];
  const provider = createScopedBridgeCredentialProvider({
    bridgeId: "bridge-a",
    requirements: [{ alias: "token", kind: "secret_text" }],
    source: {
      async resolveForBridge(bridgeId: string, alias: string) {
        calls.push([bridgeId, alias]);
        return { kind: "secret_text", value: "token" } as const;
      },
      async describeForBridge(bridgeId: string, alias: string) {
        calls.push([bridgeId, `describe:${alias}`]);
        return { configured: true };
      },
    },
  });

  assert.equal("list" in provider, false);
  assert.deepEqual(await provider.resolve("token"), { kind: "secret_text", value: "token" });
  assert.deepEqual(await provider.describe("token"), { configured: true });
  assert.deepEqual(calls, [["bridge-a", "token"], ["bridge-a", "describe:token"]]);
});
