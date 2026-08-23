import assert from "node:assert/strict";
import test from "node:test";

import type {
  ProductBootstrapConfigDraft,
  ProductBootstrapConfiguration,
} from "./product-bootstrap-config-store.js";
import { ProductBootstrapConfigurationConflictError } from "./product-bootstrap-config-store.js";
import {
  ProductActivationController,
  type MountedProductBundle,
} from "./product-activation-controller.js";

const draft: ProductBootstrapConfigDraft = {
  householdName: "梧桐家",
  agentName: "小满",
  modelReference: "gpt/gpt-5.4",
  modelProfile: {
    id: "gpt:setup:draft-a",
    provider: "gpt",
    kind: "api_key",
    secretRef: "keychain:hob-agent/setup-model:draft-a:stage-a",
  },
  bridges: [],
};

test("mounts the exact candidate before committing its activated configuration", async () => {
  const calls: string[] = [];
  const mounted = mountedBundle();
  const configuration = activatedConfiguration(1);
  let mountedDraft: ProductBootstrapConfigDraft | undefined;
  let committedDraft: ProductBootstrapConfigDraft | undefined;
  const controller = new ProductActivationController({
    mountCandidate: async (candidate) => {
      calls.push("mount");
      mountedDraft = candidate;
      return mounted.bundle;
    },
    configurationStore: {
      commit: async (expectedGeneration, candidate) => {
        calls.push("commit");
        assert.equal(expectedGeneration, 0);
        committedDraft = candidate;
        return configuration;
      },
    },
  });

  const result = await controller.activate({ draft, expectedGeneration: 0 });

  assert.deepEqual(calls, ["mount", "commit"]);
  assert.equal(mountedDraft, draft);
  assert.equal(committedDraft, draft);
  assert.deepEqual(result, { status: "activated", configuration, mounted: mounted.bundle });
  assert.equal(mounted.disposeCalls(), 0);
});

test("keeps the configuration uncommitted when the candidate does not become ready", async () => {
  let commits = 0;
  const controller = new ProductActivationController({
    mountCandidate: async () => undefined,
    configurationStore: {
      commit: async () => {
        commits += 1;
        return activatedConfiguration(1);
      },
    },
  });

  const result = await controller.activate({ draft, expectedGeneration: 0 });

  assert.deepEqual(result, { status: "unavailable" });
  assert.equal(commits, 0);
});

test("disposes a mounted candidate when committing conflicts", async () => {
  const mounted = mountedBundle();
  const controller = new ProductActivationController({
    mountCandidate: async () => mounted.bundle,
    configurationStore: {
      commit: async () => { throw new ProductBootstrapConfigurationConflictError(); },
    },
  });

  const result = await controller.activate({ draft, expectedGeneration: 0 });

  assert.deepEqual(result, { status: "conflict" });
  assert.equal(mounted.disposeCalls(), 1);
});

test("disposes a mounted candidate when committing fails without calling it a revision conflict", async () => {
  const mounted = mountedBundle();
  const controller = new ProductActivationController({
    mountCandidate: async () => mounted.bundle,
    configurationStore: {
      commit: async () => { throw new Error("disk unavailable"); },
    },
  });

  const result = await controller.activate({ draft, expectedGeneration: 0 });

  assert.deepEqual(result, { status: "unavailable" });
  assert.equal(mounted.disposeCalls(), 1);
});

test("returns busy without mounting a second candidate while activation is in progress", async () => {
  const mounted = mountedBundle();
  let releaseMount: (() => void) | undefined;
  let mounts = 0;
  const controller = new ProductActivationController({
    mountCandidate: async () => {
      mounts += 1;
      await new Promise<void>((resolve) => { releaseMount = resolve; });
      return mounted.bundle;
    },
    configurationStore: { commit: async () => activatedConfiguration(1) },
  });

  const first = controller.activate({ draft, expectedGeneration: 0 });
  await Promise.resolve();
  const second = await controller.activate({ draft, expectedGeneration: 0 });
  releaseMount?.();

  assert.deepEqual(second, { status: "busy" });
  assert.equal(mounts, 1);
  assert.equal((await first).status, "activated");
});

function activatedConfiguration(generation: number): ProductBootstrapConfiguration {
  return {
    ...draft,
    version: "hob.product-config/v2",
    generation,
    activatedAt: "2026-08-23T00:00:00.000Z",
  };
}

function mountedBundle(): { readonly bundle: MountedProductBundle; readonly disposeCalls: () => number } {
  let calls = 0;
  return {
    bundle: { dispose: async () => { calls += 1; } },
    disposeCalls: () => calls,
  };
}
