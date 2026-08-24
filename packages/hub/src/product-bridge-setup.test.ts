import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ProductBridgeSetup } from "./product-bridge-setup.js";
import { ProductSetupDraftStore } from "./product-setup-draft-store.js";
import { createBridgeProductBundle, productBridgeAdapterRegistration } from "./bridge/bridge-bundle.js";
import { HOME_ASSISTANT_ADAPTER_REGISTRATION } from "./bridge/home-assistant-bridge.js";

class MemoryVault {
  readonly values = new Map<string, string>();
  readonly deleted: string[] = [];
  read(reference: string) { return Promise.resolve(this.values.get(reference)); }
  write(reference: string, value: string) { this.values.set(reference, value); return Promise.resolve(); }
  delete(reference: string) { this.deleted.push(reference); this.values.delete(reference); return Promise.resolve(); }
}

const registration = {
  adapterType: "fixture-peer",
  label: "Fixture Peer",
  credentialAlias: "access-token",
  normalizeConfig(input: Readonly<Record<string, unknown>>) {
    if (typeof input.serverAddress !== "string") throw new TypeError();
    return { serverAddress: input.serverAddress };
  },
  displayEndpoint(config: Readonly<Record<string, unknown>>) { return String(config.serverAddress); },
  probe: async () => ({
    status: "connected" as const,
    latencyMs: 28,
    summary: { states: 21, entities: 20, devices: 8, areas: 4 },
    review: { areas: [{ name: "Fixture room", deviceCount: 8 }], unassignedDeviceCount: 0, complete: true as const },
  }),
};

async function reserveBridgeLease(stage: Parameters<ProductSetupDraftStore["reserveBridgeCredential"]>[0]["stage"]) {
  const directory = await mkdtemp(join(tmpdir(), "hob-bridge-setup-draft-lease-"));
  const token = "private-bridge-setup-test-token-value-123456";
  const store = new ProductSetupDraftStore(directory, () => new Date("2026-08-24T10:00:00.000Z"), () => "draft-home");
  await store.establishSession({ sessionToken: token, sessionExpiresAt: new Date("2026-08-25T10:00:00.000Z") });
  await store.saveIdentity({ sessionToken: token, expectedRevision: 1, householdName: "测试家", agentName: "hob" });
  const model = {
    profile: { id: "custom:setup:draft-home", provider: "custom" as const, kind: "api_key" as const, secretRef: "keychain:hob-agent/setup-model:draft-home:stage" },
    modelId: "fixture-model",
  };
  await store.reserveModelCredential({ sessionToken: token, expectedRevision: 2, stage: model });
  await store.recordModelProbe({ sessionToken: token, expectedRevision: 2, stage: model, latencyMs: 1 });
  const lease = await store.reserveBridgeCredential({ sessionToken: token, expectedRevision: 3, stage });
  return { lease, dispose: () => rm(directory, { recursive: true, force: true }) };
}

test("uses the selected encrypted-vault source for new bridge setup locators", () => {
  const setup = new ProductBridgeSetup({
    credentialRefSource: "vault",
    registrations: [registration],
    createStageNonce: () => "vault-stage",
  });
  const prepared = setup.prepare({
    setupId: "draft-home",
    adapterType: "fixture-peer",
    config: { serverAddress: "fixture://peer.local" },
    credential: "request-secret",
  });
  assert.equal(prepared.status, "prepared");
  if (prepared.status !== "prepared") assert.fail("expected prepared bridge probe");
  const stage = setup.stageSetup(prepared.prepared, "draft-home");
  assert.equal(stage.credentialRefs["access-token"], `vault:hob-agent/bridge:${stage.bridgeId}:access-token`);
});

test("prepares bridge metadata before its durable credential lease authorizes a vault write", async () => {
  const vault = new MemoryVault();
  const setup = new ProductBridgeSetup({ vault, registrations: [registration], createStageNonce: () => "stage-1" });
  const prepared = setup.prepare({
    setupId: "draft-home",
    adapterType: "fixture-peer",
    config: { serverAddress: "fixture://peer.local" },
    credential: "request-local-bridge-secret",
  });
  assert.equal(prepared.status, "prepared");
  if (prepared.status !== "prepared") assert.fail("expected prepared bridge probe");
  assert.equal(vault.values.size, 0);

  const stage = setup.stageSetup(prepared.prepared, "draft-home");
  await assert.rejects(
    setup.execute({ prepared: prepared.prepared, stage, credentialLease: { stage } as never }),
    /durable staging lease/,
  );
  assert.equal(vault.values.size, 0);
  const owner = await reserveBridgeLease(stage);
  const result = await setup.execute({
    prepared: prepared.prepared,
    stage,
    credentialLease: owner.lease,
  });
  assert.equal(result.status, "ready");
  if (result.status !== "ready") assert.fail("expected ready bridge probe");
  assert.match(result.stage.bridgeId, /^bridge-[a-f0-9]{16}$/u);
  assert.equal(result.stage.credentialRefs["access-token"], `keychain:hob-agent/bridge:${result.stage.bridgeId}:access-token`);
  assert.equal(vault.values.get(result.stage.credentialRefs["access-token"]!), "request-local-bridge-secret");
  assert.equal(result.stage.endpoint, "fixture://peer.local");
  assert.deepEqual(result.stage.config, { serverAddress: "fixture://peer.local" });
  await setup.discard(result.stage);
  assert.equal(vault.values.size, 0);
  await owner.dispose();
});

test("returns a rejected probe to the lease owner without deciding credential cleanup", async () => {
  const vault = new MemoryVault();
  const setup = new ProductBridgeSetup({
    vault,
    createStageNonce: () => "stage-rejected",
    registrations: [{ ...registration, probe: async () => ({ status: "credential_rejected" as const }) }],
  });
  const prepared = setup.prepare({
    setupId: "draft-home",
    adapterType: "fixture-peer",
    config: { serverAddress: "fixture://peer.local" },
    credential: "wrong-secret",
  });
  assert.equal(prepared.status, "prepared");
  if (prepared.status !== "prepared") assert.fail("expected prepared bridge probe");
  const stage = setup.stageSetup(prepared.prepared, "draft-home");
  const owner = await reserveBridgeLease(stage);
  assert.deepEqual(await setup.execute({ prepared: prepared.prepared, stage, credentialLease: owner.lease }), { status: "credential_rejected" });
  assert.equal(vault.values.size, 1);
  await setup.discard(stage);
  assert.equal(vault.values.size, 0);
  assert.equal(vault.deleted.length, 1);
  await owner.dispose();
});

test("cancelling a bridge probe waits for the catalog probe and leaves exact cleanup to its lease owner", async () => {
  const vault = new MemoryVault();
  const signal = new AbortController();
  let receivedSignal: AbortSignal | undefined;
  let start: (() => void) | undefined;
  let finish: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { start = resolve; });
  const settled = new Promise<void>((resolve) => { finish = resolve; });
  const setup = new ProductBridgeSetup({
    vault,
    createStageNonce: () => "stage-cancelled",
    registrations: [{
      ...registration,
      probe: async ({ signal: probeSignal }) => {
        receivedSignal = probeSignal;
        start?.();
        await settled;
        return {
          status: "connected" as const,
          latencyMs: 28,
          summary: { states: 21, entities: 20, devices: 8, areas: 4 },
          review: { areas: [{ name: "Fixture room", deviceCount: 8 }], unassignedDeviceCount: 0, complete: true as const },
        };
      },
    }],
  });
  const prepared = setup.prepare({
    setupId: "draft-home",
    adapterType: "fixture-peer",
    config: { serverAddress: "fixture://peer.local" },
    credential: "request-local-bridge-secret",
  });
  assert.equal(prepared.status, "prepared");
  if (prepared.status !== "prepared") assert.fail("expected prepared bridge probe");
  const stage = setup.stageSetup(prepared.prepared, "draft-home");
  const owner = await reserveBridgeLease(stage);
  const probing = setup.execute({
    prepared: prepared.prepared,
    stage,
    credentialLease: owner.lease,
    signal: signal.signal,
  });
  await started;
  signal.abort();
  let completed = false;
  void probing.finally(() => { completed = true; }).catch(() => undefined);
  await Promise.resolve();
  assert.equal(completed, false);
  finish?.();
  assert.deepEqual(await probing, { status: "endpoint_unreachable" });
  assert.equal(receivedSignal, signal.signal);
  assert.equal(vault.values.size, 1);
  await setup.discard(stage);
  assert.equal(vault.values.size, 0);
  assert.equal(vault.deleted.length, 1);
  await owner.dispose();
});

test("rejects an invalid adapter display endpoint before staging a credential", async () => {
  const vault = new MemoryVault();
  const setup = new ProductBridgeSetup({
    vault,
    registrations: [{ ...registration, displayEndpoint: () => "peer\nsecret" }],
  });

  assert.deepEqual(setup.prepare({
    setupId: "draft-home",
    adapterType: "fixture-peer",
    config: { serverAddress: "fixture://peer.local" },
    credential: "request-local-bridge-secret",
  }), { status: "incompatible" });
  assert.equal(vault.values.size, 0);
});

test("uses only the setup registrations published by its product bundle", () => {
  const bundle = createBridgeProductBundle({
    adapterRegistrations: [productBridgeAdapterRegistration(HOME_ASSISTANT_ADAPTER_REGISTRATION)],
    setupRegistrations: [],
  });
  const setup = new ProductBridgeSetup({
    bundle,
    vault: new MemoryVault(),
  });

  assert.deepEqual(setup.prepare({
    setupId: "draft-home",
    adapterType: "home-assistant",
    config: { baseUrl: "http://ha.local:8123" },
    credential: "request-local-bridge-secret",
  }), { status: "incompatible" });
});
