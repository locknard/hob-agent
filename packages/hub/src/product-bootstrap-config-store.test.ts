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
      modelBaseURL: "http://127.0.0.1:8080/v1/",
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
    assert.equal(committed.modelBaseURL, "http://127.0.0.1:8080/v1");
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

test("persists a complete, non-secret private voice runtime configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-product-config-voice-"));
  try {
    const store = new ProductBootstrapConfigStore(directory);
    const committed = await store.commit(0, {
      householdName: "梧桐家", agentName: "小满", modelReference: "custom/model",
      modelProfile: { id: "custom:setup:draft-voice", provider: "custom", kind: "api_key", secretRef: "keychain:hob-agent/setup-model:draft-voice:stage" },
      bridges: [],
      voice: {
        asr: { transport: "wyoming", endpoint: "wyoming://voice.local:10700", model: "tiny" },
        tts: { transport: "openai_http", endpoint: "http://127.0.0.1:9880", credentialRef: "keychain:hob-agent/voice:tts:draft-voice:tts-one", locale: "zh-CN", voice: "warm", model: "kokoro" },
      },
    });
    assert.deepEqual(await store.load(), committed);
    const source = await readFile(join(directory, "product-config.json"), "utf8");
    assert.equal(source.includes("raw-voice-credential"), false);
    await assert.rejects(store.commit(1, {
      ...committed,
      voice: {
        asr: { transport: "wyoming", endpoint: "wyoming://voice.local:10700", credential: "raw-voice-credential" },
        tts: { transport: "openai_http", endpoint: "http://voice.local:9880", locale: "zh-CN" },
      },
    } as never), /Voice configuration is invalid/);
    for (const voice of [
      {
        asr: { transport: "wyoming", endpoint: "wyoming://voice.local:10700", credentialRef: "keychain:hob-agent/voice:asr:draft-voice:asr-one" },
        tts: { transport: "openai_http", endpoint: "http://voice.local:9880", locale: "zh-CN" },
      },
      {
        asr: { transport: "openai_http", endpoint: "http://voice.local:9880" },
        tts: { transport: "wyoming", endpoint: "wyoming://voice.local:10700", credentialRef: "keychain:hob-agent/voice:tts:draft-voice:tts-one", locale: "zh-CN" },
      },
    ]) {
      await assert.rejects(store.commit(1, { ...committed, voice } as never), /Voice configuration is invalid/);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("canonicalizes OpenAI voice service roots and rejects Wyoming TTS model settings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-product-config-voice-contract-"));
  try {
    const store = new ProductBootstrapConfigStore(directory);
    const base = {
      householdName: "梧桐家", agentName: "小满", modelReference: "custom/model",
      modelProfile: { id: "custom:setup:draft-voice-contract", provider: "custom", kind: "api_key" as const, secretRef: "keychain:hob-agent/setup-model:draft-voice-contract:stage" },
      bridges: [],
    };
    const committed = await store.commit(0, {
      ...base,
      voice: {
        asr: { transport: "openai_http", endpoint: "https://voice.example.test/v1/", credentialRef: "keychain:hob-agent/voice:asr:draft-voice-contract:asr-one" },
        tts: { transport: "openai_http", endpoint: "http://127.0.0.1:9880/v1", locale: "zh-CN" },
      },
    });
    assert.deepEqual(committed.voice, {
      asr: { transport: "openai_http", endpoint: "https://voice.example.test", credentialRef: "keychain:hob-agent/voice:asr:draft-voice-contract:asr-one" },
      tts: { transport: "openai_http", endpoint: "http://127.0.0.1:9880", locale: "zh-CN" },
    });
    const tcpWyoming = await store.commit(1, {
      ...base,
      voice: {
        asr: { transport: "wyoming", endpoint: "tcp://127.0.0.1:10700" },
        tts: { transport: "wyoming", endpoint: "tcp://127.0.0.1:10701", locale: "zh-CN" },
      },
    });
    assert.deepEqual(tcpWyoming.voice, {
      asr: { transport: "wyoming", endpoint: "wyoming://127.0.0.1:10700" },
      tts: { transport: "wyoming", endpoint: "wyoming://127.0.0.1:10701", locale: "zh-CN" },
    });
    await assert.rejects(store.commit(2, {
      ...base,
      voice: {
        asr: { transport: "wyoming", endpoint: "wyoming://127.0.0.1:10700" },
        tts: { transport: "wyoming", endpoint: "wyoming://127.0.0.1:10700", locale: "zh-CN", model: "unsupported-model-field" },
      },
    }), /Voice configuration is invalid/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("loads v2 configuration without voice and rejects an unknown configuration version", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-product-config-v2-"));
  try {
    const store = new ProductBootstrapConfigStore(directory);
    await store.commit(0, {
      householdName: "梧桐家", agentName: "小满", modelReference: "custom/model",
      modelProfile: { id: "custom:setup:draft-v2", provider: "custom", kind: "api_key", secretRef: "keychain:hob-agent/setup-model:draft-v2:stage" }, bridges: [],
    });
    const path = join(directory, "product-config.json");
    const v2 = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    v2.version = "hob.product-config/v2";
    await writeFile(path, `${JSON.stringify(v2)}\n`, { mode: 0o600 });
    const loaded = await store.load();
    assert.equal(loaded?.version, "hob.product-config/v3");
    assert.equal(loaded?.voice, undefined);

    v2.version = "hob.product-config/v99";
    await writeFile(path, `${JSON.stringify(v2)}\n`, { mode: 0o600 });
    await assert.rejects(store.load(), /header is invalid/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("commits voice changes without replacing the active non-voice configuration or activation time", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-product-config-voice-commit-"));
  try {
    const activatedAt = new Date("2026-08-24T10:00:00.000Z");
    const store = new ProductBootstrapConfigStore(directory, () => activatedAt);
    const base = await store.commit(0, {
      householdName: "梧桐家", agentName: "小满", modelReference: "custom/model",
      modelBaseURL: "https://model.example.test/v1",
      modelProfile: { id: "custom:setup:active", provider: "custom", kind: "api_key", secretRef: "keychain:hob-agent/setup-model:active:model" },
      bridges: [{
        bridgeId: "ha-home", adapterType: "home-assistant", config: { baseUrl: "http://ha.local:8123" },
        credentialRefs: { access: "keychain:hob-agent/bridge:ha-home:access" },
      }],
    });
    const enabled = await store.commitVoice(1, {
      asr: { transport: "openai_http", endpoint: "http://127.0.0.1:9000", credentialRef: "keychain:hob-agent/voice:asr:voice-a:credential-a" },
      tts: { transport: "openai_http", endpoint: "http://127.0.0.1:9001", credentialRef: "keychain:hob-agent/voice:tts:voice-a:credential-a", locale: "zh-CN", voice: "warm" },
    });
    const replaced = await store.commitVoice(2, {
      asr: { transport: "wyoming", endpoint: "wyoming://voice.local:10700" },
      tts: { transport: "wyoming", endpoint: "wyoming://voice.local:10700", locale: "zh-CN", voice: "calm" },
    });
    const disabled = await store.commitVoice(3, undefined);

    assert.equal(enabled.generation, 2);
    assert.equal(replaced.generation, 3);
    assert.equal(disabled.generation, 4);
    assert.equal(disabled.activatedAt, base.activatedAt);
    assert.deepEqual({
      householdName: disabled.householdName,
      agentName: disabled.agentName,
      modelReference: disabled.modelReference,
      modelBaseURL: disabled.modelBaseURL,
      modelProfile: disabled.modelProfile,
      bridges: disabled.bridges,
    }, {
      householdName: base.householdName,
      agentName: base.agentName,
      modelReference: base.modelReference,
      modelBaseURL: base.modelBaseURL,
      modelProfile: base.modelProfile,
      bridges: base.bridges,
    });
    assert.equal(disabled.voice, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects voice changes that have no current configuration or a stale generation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-product-config-voice-conflict-"));
  try {
    const store = new ProductBootstrapConfigStore(directory);
    await assert.rejects(store.commitVoice(0, undefined), ProductBootstrapConfigurationConflictError);
    await store.commit(0, {
      householdName: "梧桐家", agentName: "小满", modelReference: "custom/model",
      modelProfile: { id: "custom:setup:active", provider: "custom", kind: "api_key", secretRef: "keychain:hob-agent/setup-model:active:model" }, bridges: [],
    });
    await assert.rejects(store.commitVoice(0, undefined), ProductBootstrapConfigurationConflictError);
    assert.equal((await store.load())?.generation, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("commits only a validated operational model while preserving the activated household configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-product-config-model-commit-"));
  try {
    const store = new ProductBootstrapConfigStore(directory, () => new Date("2026-08-24T10:00:00.000Z"));
    const initial = await store.commit(0, {
      householdName: "梧桐家", agentName: "小满", modelReference: "custom/old-model",
      modelBaseURL: "https://old.example.test/v1", bridges: [],
      modelProfile: { id: "custom:setup:initial", provider: "custom", kind: "api_key", secretRef: "keychain:hob-agent/setup-model:initial:stage" },
      voice: {
        asr: { transport: "wyoming", endpoint: "wyoming://voice.local:10700" },
        tts: { transport: "wyoming", endpoint: "wyoming://voice.local:10700", locale: "zh-CN" },
      },
    });

    const committed = await store.commitModel(1, {
      modelReference: "custom/new-model",
      modelBaseURL: "https://models.example.test/v1/",
      modelProfile: {
        id: "custom:operational:candidate-next",
        provider: "custom",
        kind: "api_key",
        secretRef: "keychain:hob-agent/model:candidate-next:nonce-next",
      },
    });

    assert.equal(committed.generation, 2);
    assert.equal(committed.activatedAt, initial.activatedAt);
    assert.equal(committed.modelBaseURL, "https://models.example.test/v1");
    assert.deepEqual(committed.voice, initial.voice);
    assert.equal(committed.householdName, initial.householdName);
    await assert.rejects(store.commitModel(2, {
      modelReference: "gpt/gpt-5", modelProfile: {
        id: "custom:operational:candidate-next", provider: "custom", kind: "api_key",
        secretRef: "keychain:hob-agent/model:candidate-next:nonce-next",
      },
    }), /Model profile is invalid/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
