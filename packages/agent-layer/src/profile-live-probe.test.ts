import assert from "node:assert/strict";
import test from "node:test";

import { probeProfileConnection } from "./profile-live-probe.js";
import { ProviderProbePolicy, ProviderProbePolicyError } from "./provider-probe-policy.js";

const vault = {
  read: async () => "api-key",
  write: async () => {},
  delete: async () => {},
};

test("probes an API-key profile through a credential store scoped to its provider", async () => {
  let requestedProvider: string | undefined;
  const result = await probeProfileConnection({
    profile: { id: "gpt:primary", provider: "gpt", kind: "api_key", secretRef: "keychain:hob-agent/gpt:primary" },
    vault,
    modelId: "gpt-5.4",
    createModels: async (credentials) => {
      assert.deepEqual(await credentials.read("openai"), { type: "api_key", key: "api-key" });
      assert.equal(await credentials.read("anthropic"), undefined);
      return {
        getModel: (provider, model) => { requestedProvider = provider; return { provider, id: model }; },
        completeSimple: async () => ({}),
      };
    },
    clock: (() => { let value = 0; return () => (value += 10); })(),
  });

  assert.equal(requestedProvider, "openai");
  assert.deepEqual(result, { model: "gpt/gpt-5.4", status: "ok", latencyMs: 10 });
});

test("rejects profile kinds that cannot safely provide a pi credential", async () => {
  await assert.rejects(
    probeProfileConnection({
      profile: { id: "claude:external", provider: "claude", kind: "external_cli" },
      vault,
      modelId: "claude-sonnet-4-6",
      createModels: async () => ({ getModel: () => undefined, completeSimple: async () => ({}) }),
    }),
    /cannot provide credentials/,
  );
});

test("requires OAuth probes to persist refreshed profile expiry metadata", async () => {
  await assert.rejects(
    probeProfileConnection({
      profile: { id: "claude:household", provider: "claude", kind: "oauth", secretRef: "keychain:hob-agent/claude:household" },
      vault,
      modelId: "claude-sonnet-4-6",
      createModels: async () => ({ getModel: () => undefined, completeSimple: async () => ({}) }),
    }),
    /OAuth probe requires profile metadata/,
  );
});

test("applies per-profile paid-probe throttling to the live connection path", async () => {
  const policy = new ProviderProbePolicy({ clock: () => 1_000 });
  const options = {
    profile: { id: "gpt:primary", provider: "gpt", kind: "api_key" as const, secretRef: "keychain:hob-agent/gpt:primary" },
    vault,
    modelId: "gpt-5.4",
    policy,
    createModels: async () => ({
      getModel: (provider: string, model: string) => ({ provider, id: model }),
      completeSimple: async () => ({}),
    }),
  };

  await probeProfileConnection(options);
  await assert.rejects(
    probeProfileConnection(options),
    (error: Error) => error instanceof ProviderProbePolicyError && error.reason === "throttled",
  );
});
