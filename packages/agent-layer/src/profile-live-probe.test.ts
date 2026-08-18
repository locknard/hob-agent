import assert from "node:assert/strict";
import test from "node:test";

import type { GenerateOptions, StreamChunk } from "@deepseek-ai/dsh-llm";

import { probeProfileConnection } from "./profile-live-probe.js";
import { ProviderProbePolicy, ProviderProbePolicyError } from "./provider-probe-policy.js";

const vault = {
  read: async () => "api-key",
  write: async () => {},
  delete: async () => {},
};

async function* stop(): AsyncIterable<StreamChunk> {
  yield { type: "finish", reason: { kind: "stop" } };
}

function runtime(onRequest?: (options: GenerateOptions) => void) {
  return {
    resolveModelInfo: async (provider: string, model: string) => ({ provider, id: model, name: model }),
    stream: (options: GenerateOptions) => {
      onRequest?.(options);
      return stop();
    },
  };
}

test("probes an API-key profile through a DSH runtime scoped to its provider", async () => {
  let requestedProvider: string | undefined;
  const result = await probeProfileConnection({
    profile: { id: "gpt:primary", provider: "gpt", kind: "api_key", secretRef: "keychain:hob-agent/gpt:primary" },
    vault,
    modelId: "gpt-5.4",
    createRuntime: async ({ profile }) => {
      assert.equal(profile.id, "gpt:primary");
      return runtime((options) => { requestedProvider = options.provider; });
    },
    clock: (() => { let value = 0; return () => (value += 10); })(),
  });

  assert.equal(requestedProvider, "openai");
  assert.deepEqual(result, { model: "gpt/gpt-5.4", status: "ok", latencyMs: 10 });
});

test("rejects profile kinds that cannot safely provide a DSH credential route", async () => {
  await assert.rejects(
    probeProfileConnection({
      profile: { id: "claude:external", provider: "claude", kind: "external_cli" },
      vault,
      modelId: "claude-sonnet-4-6",
      runtime: runtime(),
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
      runtime: runtime(),
    }),
    /OAuth probe requires profile metadata/,
  );
});

test("fails closed when a profile probe has no DSH runtime boundary", async () => {
  await assert.rejects(
    probeProfileConnection({
      profile: { id: "gpt:missing-runtime", provider: "gpt", kind: "api_key", secretRef: "keychain:hob-agent/gpt:missing-runtime" },
      vault,
      modelId: "gpt-5.4",
    }),
    /requires a DSH LlmRuntime/,
  );
});

test("applies per-profile paid-probe throttling to the live connection path", async () => {
  const policy = new ProviderProbePolicy({ clock: () => 1_000 });
  const options = {
    profile: { id: "gpt:primary", provider: "gpt", kind: "api_key" as const, secretRef: "keychain:hob-agent/gpt:primary" },
    vault,
    modelId: "gpt-5.4",
    policy,
    runtime: runtime(),
  };

  await probeProfileConnection(options);
  await assert.rejects(
    probeProfileConnection(options),
    (error: Error) => error instanceof ProviderProbePolicyError && error.reason === "throttled",
  );
});
