import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { InboxRequestAuthenticator } from "@hob-agent/inbox-web/http";
import type {
  ProductSetupDraftPort,
  ProductSetupDraftProjection,
} from "@hob-agent/inbox-web/setup";

import type { ProductBootstrapConfigDraft } from "./product-bootstrap-config-store.js";
import { ProductBootstrapConfigStore } from "./product-bootstrap-config-store.js";
import {
  ProductRuntimeSupervisor,
  type RuntimeProductBundle,
} from "./product-runtime-supervisor.js";

const draft: ProductBootstrapConfigDraft = {
  householdName: "梧桐家",
  agentName: "小满",
  modelReference: "custom/home-model",
  modelBaseURL: "https://model.example.test/v1",
  modelProfile: {
    id: "custom:setup:runtime-supervisor",
    provider: "custom",
    kind: "api_key",
    secretRef: "keychain:hob-agent/setup-model:runtime-supervisor:stage-a",
  },
  bridges: [],
};

test("activates the exact mapped draft, then keeps the paired product session for onboarding", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-product-runtime-supervisor-"));
  const setup = new MapSetupDrafts(draft);
  const configurationStore = new ProductBootstrapConfigStore(directory);
  const mounted = mountedBundle();
  let mountedDraft: ProductBootstrapConfigDraft | undefined;
  let authenticator: InboxRequestAuthenticator | undefined;
  const runtime = new ProductRuntimeSupervisor({
    dataDirectory: directory,
    port: 0,
    pairingCode: "LIVE-HOME",
    setupDrafts: setup,
    configurationStore,
    mountOperational: async ({ candidate, authenticateProductSession, host }) => {
      mountedDraft = candidate;
      authenticator = authenticateProductSession;
      mounted.setOnAttach(() => host.switchTo((request, response) => {
        response.statusCode = request.url === "/onboarding" ? 200 : 404;
        response.end();
      }));
      return mounted.bundle;
    },
    announce: () => undefined,
  });
  try {
    await runtime.start();
    const origin = runtime.origin;
    const response = await fetch(`${origin}/setup/activate`, {
      method: "POST",
      redirect: "manual",
      headers: {
        origin,
        cookie: "hob_product_session=paired-session-token-which-is-long-enough",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "revision=7",
    });

    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "/onboarding");
    assert.deepEqual(mountedDraft, draft);
    assert.equal(mounted.attachCalls(), 1);
    assert.equal((await configurationStore.load())?.generation, 1);
    assert.equal((await fetch(`${origin}/setup`)).status, 404);
    assert.equal((await fetch(`${origin}/onboarding`)).status, 200);
    assert.equal(await authenticator?.({
      authorization: undefined,
      cookie: "hob_product_session=paired-session-token-which-is-long-enough",
      origin,
    }), true);
    await runtime.stop();
    assert.equal(mounted.disposeCalls(), 1);
  } finally {
    await runtime.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps setup live and leaves configuration absent when the candidate cannot mount", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-product-runtime-supervisor-failure-"));
  const configurationStore = new ProductBootstrapConfigStore(directory);
  const runtime = new ProductRuntimeSupervisor({
    dataDirectory: directory,
    port: 0,
    pairingCode: "LIVE-HOME",
    setupDrafts: new MapSetupDrafts(draft),
    configurationStore,
    mountOperational: async () => undefined,
    announce: () => undefined,
  });
  try {
    await runtime.start();
    const origin = runtime.origin;
    const response = await fetch(`${origin}/setup/activate`, {
      method: "POST",
      headers: {
        origin,
        cookie: "hob_product_session=paired-session-token-which-is-long-enough",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "revision=7",
    });

    assert.equal(response.status, 503);
    assert.match(await response.text(), /已验证的设置仍然保留/u);
    assert.equal(await configurationStore.load(), undefined);
    assert.equal((await fetch(`${origin}/setup`, {
      headers: { cookie: "hob_product_session=paired-session-token-which-is-long-enough" },
    })).status, 200);
  } finally {
    await runtime.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("restores an active generation directly into the product bundle after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-product-runtime-supervisor-restart-"));
  const configurationStore = new ProductBootstrapConfigStore(directory);
  await configurationStore.commit(0, draft);
  const mounted = mountedBundle();
  let mountedDraft: ProductBootstrapConfigDraft | undefined;
  const runtime = new ProductRuntimeSupervisor({
    dataDirectory: directory,
    port: 0,
    pairingCode: "LIVE-HOME",
    setupDrafts: new MapSetupDrafts(draft),
    configurationStore,
    mountOperational: async ({ candidate }) => {
      mountedDraft = candidate;
      return mounted.bundle;
    },
    announce: () => undefined,
  });
  try {
    await runtime.start();
    assert.equal(mountedDraft?.modelReference, draft.modelReference);
    assert.equal(mountedDraft?.householdName, draft.householdName);
    assert.equal(mounted.attachCalls(), 1);
    assert.equal(runtime.mode, "operational");
  } finally {
    await runtime.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("mounts the private voice provider setup capability without opening a second runtime", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-product-runtime-supervisor-voice-"));
  const calls: string[] = [];
  const runtime = new ProductRuntimeSupervisor({
    dataDirectory: directory,
    port: 0,
    pairingCode: "LIVE-HOME",
    setupDrafts: new MapSetupDrafts(draft),
    voiceSetup: {
      probe: async ({ track }) => {
        calls.push(track.kind);
        return { status: "ready", latencyMs: 4 };
      },
    },
    mountOperational: async () => undefined,
    announce: () => undefined,
  });
  try {
    await runtime.start();
    const result = await runtime.context.productVoiceSetup.probe({
      setupId: "runtime-supervisor",
      track: { kind: "tts", transport: "wyoming", endpoint: "wyoming://127.0.0.1:10301", locale: "zh-CN" },
    });
    assert.equal(result.status, "ready");
    assert.deepEqual(calls, ["tts"]);
    const turn = runtime.context.privateVoiceRuntime.dispatch("setup-browser", {
      type: "begin",
      turnId: "turn-a",
    });
    assert.equal(turn.state.activeTurnId, "turn-a");
  } finally {
    await runtime.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

class MapSetupDrafts implements ProductSetupDraftPort {
  private readonly projection: ProductSetupDraftProjection = {
    draftId: "runtime-supervisor",
    revision: 7,
    stage: "map",
    householdName: "梧桐家",
    agentName: "小满",
  };

  constructor(private readonly candidate: ProductBootstrapConfigDraft) {}

  async establishSession(): Promise<ProductSetupDraftProjection> { return this.projection; }
  async loadForSession(token: string): Promise<ProductSetupDraftProjection | undefined> {
    return token === "paired-session-token-which-is-long-enough" ? this.projection : undefined;
  }
  async saveIdentity(): Promise<ProductSetupDraftProjection> { return this.projection; }
  async probeModel(): Promise<never> { throw new Error("not used"); }
  async probeBridge(): Promise<never> { throw new Error("not used"); }
  async activationCandidateForSession(token: string, revision: number): Promise<ProductBootstrapConfigDraft | undefined> {
    return token === "paired-session-token-which-is-long-enough" && revision === 7 ? this.candidate : undefined;
  }
}

function mountedBundle(): {
  readonly bundle: RuntimeProductBundle;
  readonly attachCalls: () => number;
  readonly disposeCalls: () => number;
  readonly setOnAttach: (callback: () => void) => void;
} {
  let attached = 0;
  let disposed = 0;
  let onAttach = (): void => undefined;
  return {
    bundle: {
      attach: () => { attached += 1; onAttach(); },
      dispose: async () => { disposed += 1; },
    },
    attachCalls: () => attached,
    disposeCalls: () => disposed,
    setOnAttach: (callback) => { onAttach = callback; },
  };
}
