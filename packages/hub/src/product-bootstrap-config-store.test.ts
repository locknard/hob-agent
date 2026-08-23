import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ProductBootstrapConfigStore,
  ProductBootstrapConfigurationConflictError,
} from "./product-bootstrap-config-store.js";

test("commits and reloads one composition-root product configuration generation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-product-config-"));
  try {
    const store = new ProductBootstrapConfigStore(directory);
    const committed = await store.commit(0, {
      householdName: "梧桐家",
      agentName: "小满",
      modelReference: "custom/deepseek-v4-flash-0731",
      modelBaseURL: "https://model.example.test/v1",
      modelProfile: {
        id: "custom:setup:draft-a",
        provider: "custom",
        kind: "api_key",
        secretRef: "keychain:hob-agent/setup-model:draft-a:stage-a",
      },
      bridges: [{
        bridgeId: "ha-home",
        adapterType: "home-assistant",
        config: { baseUrl: "http://ha.local:8123", authenticationPrincipal: "owner" },
        credentialRefs: { "access-token": "keychain:hob-agent/bridge:ha-home:access-token" },
      }],
    });

    assert.equal(committed.generation, 1);
    assert.deepEqual(await store.load(), committed);
    assert.equal((await stat(join(directory, "product-config.json"))).mode & 0o777, 0o600);
    const source = await readFile(join(directory, "product-config.json"), "utf8");
    assert.equal(source.includes("access-token\":"), true);
    assert.equal(source.includes("home-assistant-secret"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("preserves the active generation across stale writes and secret-shaped bridge config", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-product-config-guard-"));
  try {
    const store = new ProductBootstrapConfigStore(directory);
    await store.commit(0, {
      householdName: "我的家",
      agentName: "hob",
      modelReference: "deepseek/deepseek-chat",
      modelProfile: {
        id: "deepseek:setup:draft-a",
        provider: "deepseek",
        kind: "api_key",
        secretRef: "keychain:hob-agent/setup-model:draft-a:stage-a",
      },
      bridges: [],
    });
    await assert.rejects(
      store.commit(0, {
        householdName: "我的家", agentName: "hob", modelReference: "deepseek/deepseek-reasoner",
        modelProfile: { id: "deepseek:setup:draft-a", provider: "deepseek", kind: "api_key", secretRef: "keychain:hob-agent/setup-model:draft-a:stage-a" },
        bridges: [],
      }),
      ProductBootstrapConfigurationConflictError,
    );
    await assert.rejects(
      store.commit(1, {
        householdName: "我的家",
        agentName: "hob",
        modelReference: "deepseek/deepseek-chat",
        modelProfile: { id: "deepseek:setup:draft-a", provider: "deepseek", kind: "api_key", secretRef: "keychain:hob-agent/setup-model:draft-a:stage-a" },
        bridges: [{
          bridgeId: "ha-home",
          adapterType: "home-assistant",
          config: { baseUrl: "http://ha.local:8123", accessToken: "secret" },
          credentialRefs: {},
        }],
      }),
      /secret-shaped field/,
    );
    assert.equal((await store.load())?.generation, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("binds the activated model to the exact staged profile that passed setup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-product-config-model-profile-"));
  try {
    const store = new ProductBootstrapConfigStore(directory);
    const base = {
      householdName: "梧桐家",
      agentName: "小满",
      modelReference: "custom/deepseek-v4-flash-0731",
      modelBaseURL: "https://model.example.test/v1",
      bridges: [],
    } as const;

    await assert.rejects(store.commit(0, {
      ...base,
      modelProfile: {
        id: "deepseek:setup:draft-a",
        provider: "deepseek",
        kind: "api_key",
        secretRef: "keychain:hob-agent/setup-model:draft-a:stage-a",
      },
    }), /Model profile is invalid/);

    await assert.rejects(store.commit(0, {
      ...base,
      modelProfile: {
        id: "custom:setup:draft-a",
        provider: "custom",
        kind: "api_key",
        secretRef: "keychain:hob-agent/setup-model:another-draft:stage-a",
      },
    }), /Model profile is invalid/);

    assert.equal(await store.load(), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("recovers an abandoned configuration lock while preserving a fresh owner", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-product-config-lock-"));
  try {
    const lockPath = join(directory, "product-config.lock");
    const store = new ProductBootstrapConfigStore(directory);
    await writeFile(lockPath, "abandoned-lock", { mode: 0o600 });
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);
    const draft = {
      householdName: "我的家",
      agentName: "hob",
      modelReference: "gpt/gpt-5.4",
      modelProfile: { id: "gpt:setup:draft-a", provider: "gpt", kind: "api_key" as const, secretRef: "keychain:hob-agent/setup-model:draft-a:stage-a" },
      bridges: [],
    };
    assert.equal((await store.commit(0, draft)).generation, 1);

    await writeFile(lockPath, "active-owner", { mode: 0o600 });
    await assert.rejects(
      store.commit(1, draft),
      /configuration is busy/,
    );
    assert.equal(await readFile(lockPath, "utf8"), "active-owner");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
